// Copyright (C) 2026 Michael Kazakov. Subject to GNU General Public License version 3.
#include "IPFSClusterHost.h"
#include "Internal.h"
#include <Utility/PathManip.h>
#include "../ListingInput.h"
#include "ConnectionsPool.h"
#include "Cache.h"
#include "File.h"
#include "PathRoutines.h"
#include "Requests.h"
#include <sys/dirent.h>
#include <fmt/core.h>

#include <algorithm>
#include <memory>
#include <unordered_set>

namespace nc::vfs {

// NB: only function-local using-directives for ipfs_cluster in this file - it is compiled as
// part of the _VFS.cpp unity build, where namespace-scope usings would leak into other backends.
const char *IPFSClusterHost::UniqueTag = "net_ipfs_cluster";

struct IPFSClusterHost::State {
    State(const ipfs_cluster::HostConfiguration &_config) : m_Pool{_config} {}

    ipfs_cluster::ConnectionsPool m_Pool;
    ipfs_cluster::Cache m_Cache;
};

IPFSClusterHost::IPFSClusterHost(const std::string &_server,
                                 const std::string &_user,
                                 const std::string &_passwd,
                                 bool _https,
                                 int _rest_port,
                                 int _proxy_port)
    : Host(_server, nullptr, UniqueTag),
      m_Configuration(ComposeConfiguration(_server, _user, _passwd, _https, _rest_port, _proxy_port))
{
    Init();
}

IPFSClusterHost::IPFSClusterHost(const VFSConfiguration &_config)
    : Host(_config.Get<ipfs_cluster::HostConfiguration>().server, nullptr, UniqueTag), m_Configuration(_config)
{
    Init();
}

IPFSClusterHost::~IPFSClusterHost() = default;

void IPFSClusterHost::Init()
{
    using namespace ipfs_cluster;
    I = std::make_unique<State>(Config());

    // verify that the cluster REST API is reachable and the credentials are sane
    auto ar = I->m_Pool.Get();
    const std::expected<std::vector<PinInfo>, Error> pins = RequestPins(Config(), *ar.connection);
    if( !pins )
        throw ErrorException(pins.error());
}

VFSConfiguration IPFSClusterHost::Configuration() const
{
    return m_Configuration;
}

const ipfs_cluster::HostConfiguration &IPFSClusterHost::Config() const noexcept
{
    return m_Configuration.GetUnchecked<ipfs_cluster::HostConfiguration>();
}

bool IPFSClusterHost::IsWritable() const
{
    return true;
}

// Pin names can be empty, can repeat and can contain slashes - none of which works for
// filenames. Falls back to the CID whenever the name isn't usable as-is.
static std::string EntryNameForPin(const ipfs_cluster::PinInfo &_pin, std::unordered_set<std::string> &_taken)
{
    std::string name = _pin.name;
    if( name.empty() || name == "." || name == ".." || name.contains('/') )
        name = _pin.cid;
    if( !_taken.insert(name).second ) // duplicate display name
        name = _pin.cid;
    _taken.insert(name);
    return name;
}

std::expected<void, Error> IPFSClusterHost::RefreshListingAtPath(const std::string &_path,
                                                                 const VFSCancelChecker &_cancel_checker)
{
    using namespace ipfs_cluster;
    if( _path.back() != '/' )
        throw std::invalid_argument("RefreshListingAtPath requires a path with a trailing slash");

    std::vector<EntryInfo> items;
    if( _path == "/" ) {
        auto ar = I->m_Pool.Get();
        std::expected<std::vector<PinInfo>, Error> pins = RequestPins(Config(), *ar.connection);
        if( !pins )
            return std::unexpected(pins.error());

        std::unordered_set<std::string> taken;
        for( auto &pin : *pins ) {
            if( _cancel_checker && _cancel_checker() )
                return std::unexpected(Error{Error::POSIX, ECANCELED});
            EntryInfo e;
            e.filename = EntryNameForPin(pin, taken);
            e.cid = pin.cid;
            e.creation_date = pin.created;
            e.modification_date = pin.created;
            // pin entries are files unless the underlying DAG says otherwise
            if( auto st = RequestStat(Config(), *ar.connection, pin.cid) ) {
                e.is_directory = st->is_directory;
                e.size = st->size;
            }
            items.push_back(std::move(e));
        }
    }
    else {
        const std::expected<std::string, Error> cid_path = ResolveToCidPath(_path, _cancel_checker);
        if( !cid_path )
            return std::unexpected(cid_path.error());

        auto ar = I->m_Pool.Get();
        std::expected<std::vector<EntryInfo>, Error> listing =
            RequestUnixFSListing(Config(), *ar.connection, *cid_path);
        if( !listing )
            return std::unexpected(listing.error());
        items = std::move(*listing);

        EntryInfo dotdot;
        dotdot.filename = "..";
        dotdot.is_directory = true;
        items.insert(items.begin(), std::move(dotdot));
    }

    I->m_Cache.CommitListing(_path, std::move(items));
    return {};
}

std::expected<std::string, Error> IPFSClusterHost::ResolveToCidPath(std::string_view _path,
                                                                    const VFSCancelChecker &_cancel_checker)
{
    using namespace ipfs_cluster;
    if( !IsValidInputPath(_path) )
        return std::unexpected(Error{Error::POSIX, EINVAL});

    std::string_view trimmed = _path;
    trimmed.remove_prefix(1); // leading '/'
    while( !trimmed.empty() && trimmed.back() == '/' )
        trimmed.remove_suffix(1);
    if( trimmed.empty() )
        return std::unexpected(Error{Error::POSIX, EINVAL}); // the root has no CID

    const auto first_slash = trimmed.find('/');
    const std::string pin_name(trimmed.substr(0, first_slash));
    const std::string rest = first_slash == std::string_view::npos ? "" : std::string(trimmed.substr(first_slash));

    const std::string pin_path = "/" + pin_name;
    auto [item, result] = I->m_Cache.Item(pin_path);
    if( !item ) {
        if( const std::expected<void, Error> rc = RefreshListingAtPath("/", _cancel_checker); !rc )
            return std::unexpected(rc.error());
        std::tie(item, result) = I->m_Cache.Item(pin_path);
        if( !item )
            return std::unexpected(Error{Error::POSIX, ENOENT});
    }
    return item->cid + rest;
}

std::expected<VFSListingPtr, Error> IPFSClusterHost::FetchDirectoryListing(std::string_view _path,
                                                                           unsigned long _flags,
                                                                           const VFSCancelChecker &_cancel_checker)
{
    using namespace ipfs_cluster;
    if( !IsValidInputPath(_path) )
        return std::unexpected(nc::Error{nc::Error::POSIX, EINVAL});

    const auto path = EnsureTrailingSlash(std::string(_path));

    if( _flags & VFSFlags::F_ForceRefresh )
        I->m_Cache.DiscardListing(path);

    std::vector<EntryInfo> items;
    if( auto cached = I->m_Cache.Listing(path) ) {
        items = std::move(*cached);
    }
    else {
        const std::expected<void, Error> refresh_rc = RefreshListingAtPath(path, _cancel_checker);
        if( !refresh_rc )
            return std::unexpected(refresh_rc.error());

        if( auto cached2 = I->m_Cache.Listing(path) )
            items = std::move(*cached2);
        else
            return std::unexpected(nc::Error{nc::Error::POSIX, EINVAL});
    }

    if( (_flags & VFSFlags::F_NoDotDot) || path == "/" )
        std::erase_if(items, [](const auto &_item) { return _item.filename == ".."; });
    else
        std::ranges::partition(items, [](const auto &_i) { return _i.filename == ".."; });

    using nc::base::variable_container;
    ListingInput listing_source;
    listing_source.hosts[0] = shared_from_this();
    listing_source.directories[0] = path;
    listing_source.sizes.reset(variable_container<>::type::dense);
    listing_source.btimes.reset(variable_container<>::type::sparse);
    listing_source.ctimes.reset(variable_container<>::type::sparse);
    listing_source.mtimes.reset(variable_container<>::type::sparse);

    int index = 0;
    for( auto &e : items ) {
        listing_source.filenames.emplace_back(e.filename);
        listing_source.unix_modes.emplace_back(e.is_directory ? DirectoryAccessMode : RegularFileAccessMode);
        listing_source.unix_types.emplace_back(e.is_directory ? DT_DIR : DT_REG);
        if( e.size >= 0 )
            listing_source.sizes.insert(index, e.size);
        if( e.creation_date >= 0 )
            listing_source.btimes.insert(index, e.creation_date);
        if( e.modification_date >= 0 ) {
            listing_source.ctimes.insert(index, e.modification_date);
            listing_source.mtimes.insert(index, e.modification_date);
        }
        index++;
    }

    return VFSListing::Build(std::move(listing_source));
}

std::expected<void, Error>
IPFSClusterHost::IterateDirectoryListing(std::string_view _path,
                                         const std::function<bool(const VFSDirEnt &_dirent)> &_handler)
{
    using namespace ipfs_cluster;
    if( !IsValidInputPath(_path) )
        return std::unexpected(nc::Error{nc::Error::POSIX, EINVAL});

    const auto path = EnsureTrailingSlash(std::string(_path));

    std::vector<EntryInfo> items;
    if( auto cached = I->m_Cache.Listing(path) ) {
        items = std::move(*cached);
    }
    else {
        const std::expected<void, Error> refresh_rc = RefreshListingAtPath(path, nullptr);
        if( !refresh_rc )
            return refresh_rc;

        if( auto cached2 = I->m_Cache.Listing(path) )
            items = std::move(*cached2);
        else
            return std::unexpected(nc::Error{nc::Error::POSIX, EINVAL});
    }

    std::erase_if(items, [](const auto &_item) { return _item.filename == ".."; });

    for( const auto &i : items ) {
        VFSDirEnt e;
        e.name = i.filename;
        e.type = i.is_directory ? VFSDirEnt::Dir : VFSDirEnt::Reg;
        if( !_handler(e) )
            return std::unexpected(nc::Error{nc::Error::POSIX, ECANCELED});
    }

    return {};
}

std::expected<VFSStat, Error>
IPFSClusterHost::Stat(std::string_view _path, [[maybe_unused]] unsigned long _flags, const VFSCancelChecker &_cancel_checker)
{
    using namespace ipfs_cluster;
    if( !IsValidInputPath(_path) )
        return std::unexpected(nc::Error{nc::Error::POSIX, EINVAL});

    if( _path == "/" ) {
        VFSStat st;
        st.mode = DirectoryAccessMode;
        return st;
    }

    EntryInfo item;
    auto [cached_1st, cached_1st_res] = I->m_Cache.Item(_path);
    if( cached_1st ) {
        item = std::move(*cached_1st);
    }
    else {
        if( cached_1st_res == Cache::E::NonExist )
            return std::unexpected(nc::Error{nc::Error::POSIX, ENOENT});

        const auto [directory, filename] = DeconstructPath(_path);
        if( directory.empty() )
            return std::unexpected(nc::Error{nc::Error::POSIX, EINVAL});
        const std::expected<void, Error> rc = RefreshListingAtPath(directory, _cancel_checker);
        if( !rc )
            return std::unexpected(rc.error());

        auto [cached_2nd, cached_2nd_res] = I->m_Cache.Item(_path);
        if( cached_2nd )
            item = std::move(*cached_2nd);
        else
            return std::unexpected(nc::Error{nc::Error::POSIX, ENOENT});
    }

    VFSStat st;
    st.mode = item.is_directory ? DirectoryAccessMode : RegularFileAccessMode;
    if( item.size >= 0 ) {
        st.size = item.size;
        st.meaning.size = 1;
    }
    if( item.creation_date >= 0 ) {
        st.btime.tv_sec = item.creation_date;
        st.meaning.btime = true;
    }
    if( item.modification_date >= 0 ) {
        st.mtime.tv_sec = st.ctime.tv_sec = item.modification_date;
        st.meaning.mtime = st.meaning.ctime = true;
    }

    return st;
}

std::expected<void, Error> IPFSClusterHost::CreateDirectory([[maybe_unused]] std::string_view _path,
                                                            [[maybe_unused]] int _mode,
                                                            [[maybe_unused]] const VFSCancelChecker &_cancel_checker)
{
    // the cluster pinset has no notion of empty directories
    return std::unexpected(nc::Error{nc::Error::POSIX, ENOTSUP});
}

// Both files and directories at the root level are pins, so removing either means unpinning.
static bool IsRootLevelPath(std::string_view _path)
{
    if( _path.size() < 2 || _path[0] != '/' )
        return false;
    const auto slash = _path.find('/', 1);
    return slash == std::string_view::npos || slash == _path.size() - 1;
}

std::expected<void, Error> IPFSClusterHost::RemoveDirectory(std::string_view _path,
                                                            const VFSCancelChecker &_cancel_checker)
{
    return Unlink(_path, _cancel_checker);
}

std::expected<void, Error> IPFSClusterHost::Unlink(std::string_view _path,
                                                   [[maybe_unused]] const VFSCancelChecker &_cancel_checker)
{
    if( !IsValidInputPath(_path) )
        return std::unexpected(nc::Error{nc::Error::POSIX, EINVAL});
    if( !IsRootLevelPath(_path) ) // contents of a pinned DAG are immutable
        return std::unexpected(nc::Error{nc::Error::POSIX, EROFS});

    const std::expected<std::string, Error> cid = ResolveToCidPath(_path, _cancel_checker);
    if( !cid )
        return std::unexpected(cid.error());

    const auto ar = I->m_Pool.Get();
    const std::expected<void, Error> rc = RequestUnpin(Config(), *ar.connection, *cid);
    if( !rc )
        return rc;

    I->m_Cache.CommitUnlink(_path);

    return {};
}

std::expected<std::shared_ptr<VFSFile>, Error>
IPFSClusterHost::CreateFile(std::string_view _path, [[maybe_unused]] const VFSCancelChecker &_cancel_checker)
{
    if( !IsValidInputPath(_path) )
        return std::unexpected(nc::Error{nc::Error::POSIX, EINVAL});

    return std::make_shared<ipfs_cluster::File>(_path, std::dynamic_pointer_cast<IPFSClusterHost>(shared_from_this()));
}

ipfs_cluster::ConnectionsPool &IPFSClusterHost::ConnectionsPool()
{
    return I->m_Pool;
}

ipfs_cluster::Cache &IPFSClusterHost::Cache()
{
    return I->m_Cache;
}

std::expected<void, Error> IPFSClusterHost::Rename(std::string_view _old_path,
                                                   std::string_view _new_path,
                                                   [[maybe_unused]] const VFSCancelChecker &_cancel_checker)
{
    if( !IsValidInputPath(_old_path) || !IsValidInputPath(_new_path) )
        return std::unexpected(nc::Error{nc::Error::POSIX, EINVAL});
    // renaming is changing a pin's name, which only makes sense at the root level
    if( !IsRootLevelPath(_old_path) || !IsRootLevelPath(_new_path) )
        return std::unexpected(nc::Error{nc::Error::POSIX, EROFS});

    const std::expected<std::string, Error> cid = ResolveToCidPath(_old_path, _cancel_checker);
    if( !cid )
        return std::unexpected(cid.error());

    std::string new_name(_new_path.substr(1));
    if( !new_name.empty() && new_name.back() == '/' )
        new_name.pop_back();

    const auto ar = I->m_Pool.Get();
    const std::expected<void, Error> rc = RequestRepinWithName(Config(), *ar.connection, *cid, new_name);
    if( !rc )
        return rc;

    I->m_Cache.CommitMove(_old_path, _new_path);

    return {};
}

bool IPFSClusterHost::IsDirectoryChangeObservationAvailable([[maybe_unused]] std::string_view _path)
{
    return true;
}

HostDirObservationTicket IPFSClusterHost::ObserveDirectoryChanges(std::string_view _path,
                                                                  std::function<void()> _handler)
{
    if( !IsValidInputPath(_path) )
        return {};
    const auto ticket = I->m_Cache.Observe(std::string(_path), std::move(_handler));
    return HostDirObservationTicket{ticket, shared_from_this()};
}

void IPFSClusterHost::StopDirChangeObserving(unsigned long _ticket)
{
    I->m_Cache.StopObserving(_ticket);
}

VFSMeta IPFSClusterHost::Meta()
{
    VFSMeta m;
    m.Tag = UniqueTag;
    m.SpawnWithConfig = []([[maybe_unused]] const VFSHostPtr &_parent,
                           const VFSConfiguration &_config,
                           [[maybe_unused]] VFSCancelChecker _cancel_checker) {
        return std::make_shared<IPFSClusterHost>(_config);
    };
    return m;
}

const std::string &IPFSClusterHost::Server() const noexcept
{
    return Config().server;
}

const std::string IPFSClusterHost::Username() const noexcept
{
    return Config().user;
}

int IPFSClusterHost::Port() const noexcept
{
    return Config().port;
}

int IPFSClusterHost::ProxyPort() const noexcept
{
    return Config().proxy_port;
}

VFSConfiguration IPFSClusterHost::ComposeConfiguration(const std::string &_server,
                                                       const std::string &_user,
                                                       const std::string &_passwd,
                                                       bool _https,
                                                       int _rest_port,
                                                       int _proxy_port)
{
    using namespace ipfs_cluster;
    if( _rest_port <= 0 )
        _rest_port = 9094;
    if( _proxy_port <= 0 )
        _proxy_port = 9095;

    HostConfiguration config;
    config.server = _server;
    config.user = _user;
    config.passwd = _passwd;
    config.https = _https;
    config.port = _rest_port;
    config.proxy_port = _proxy_port;
    const auto scheme = _https ? "https://" : "http://";
    config.rest_url = fmt::format("{}{}:{}/", scheme, _server, _rest_port);
    config.proxy_url = fmt::format("{}{}:{}/", scheme, _server, _proxy_port);
    config.verbose = fmt::format("ipfscluster://{}{}{}:{}",
                                 (config.user.empty() ? "" : config.user),
                                 (config.user.empty() ? "" : "@"),
                                 _server,
                                 _rest_port);

    return {std::move(config)};
}

bool IPFSClusterHost::IsValidInputPath(std::string_view _path)
{
    return !_path.empty() && _path[0] == '/';
}

} // namespace nc::vfs

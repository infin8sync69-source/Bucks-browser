// Copyright (C) 2026 Michael Kazakov. Subject to GNU General Public License version 3.
#pragma once

#include "../../include/VFS/Host.h"

namespace nc::vfs {

namespace ipfs_cluster {
class HostConfiguration;
class ConnectionsPool;
class Cache;
} // namespace ipfs_cluster

// A VFS host backed by an IPFS Cluster peer.
// The root directory is the cluster pinset: every pin shows up as an entry named after the pin's
// user-assigned name (falling back to its CID). Pins that are UnixFS directories can be browsed
// read-only below the root. Writes are supported only at the root: copying a file in adds it to
// IPFS and pins it cluster-wide, deleting an entry unpins it.
class IPFSClusterHost final : public Host
{
public:
    static const char *UniqueTag;

    IPFSClusterHost(const std::string &_server,
                    const std::string &_user,
                    const std::string &_passwd,
                    bool _https = false,
                    int _rest_port = 9094,
                    int _proxy_port = 9095);
    IPFSClusterHost(const VFSConfiguration &_config);
    ~IPFSClusterHost() override;

    VFSConfiguration Configuration() const override;

    static VFSMeta Meta();

    bool IsWritable() const override;

    std::expected<VFSListingPtr, Error> FetchDirectoryListing(std::string_view _path,
                                                              unsigned long _flags,
                                                              const VFSCancelChecker &_cancel_checker) override;

    std::expected<void, Error>
    IterateDirectoryListing(std::string_view _path,
                            const std::function<bool(const VFSDirEnt &_dirent)> &_handler) override;

    std::expected<VFSStat, Error>
    Stat(std::string_view _path, unsigned long _flags, const VFSCancelChecker &_cancel_checker) override;

    std::expected<void, Error>
    CreateDirectory(std::string_view _path, int _mode, const VFSCancelChecker &_cancel_checker) override;

    std::expected<void, Error> RemoveDirectory(std::string_view _path,
                                               const VFSCancelChecker &_cancel_checker) override;

    std::expected<void, Error> Unlink(std::string_view _path, const VFSCancelChecker &_cancel_checker) override;

    std::expected<std::shared_ptr<VFSFile>, Error> CreateFile(std::string_view _path,
                                                              const VFSCancelChecker &_cancel_checker) override;

    std::expected<void, Error>
    Rename(std::string_view _old_path, std::string_view _new_path, const VFSCancelChecker &_cancel_checker) override;

    bool IsDirectoryChangeObservationAvailable(std::string_view _path) override;

    HostDirObservationTicket ObserveDirectoryChanges(std::string_view _path, std::function<void()> _handler) override;

    const std::string &Server() const noexcept;
    const std::string Username() const noexcept;
    int Port() const noexcept;
    int ProxyPort() const noexcept;

    const ipfs_cluster::HostConfiguration &Config() const noexcept;
    ipfs_cluster::ConnectionsPool &ConnectionsPool();
    ipfs_cluster::Cache &Cache();

    // Maps a VFS path ("/pin-name/sub/dir") to an IPFS path ("<cid>/sub/dir") by resolving the
    // first component through the pinset. Returns an error if the pin is unknown.
    std::expected<std::string, Error> ResolveToCidPath(std::string_view _path,
                                                       const VFSCancelChecker &_cancel_checker);

private:
    void Init();
    void StopDirChangeObserving(unsigned long _ticket) override;
    std::expected<void, Error> RefreshListingAtPath(const std::string &_path, const VFSCancelChecker &_cancel_checker);
    static bool IsValidInputPath(std::string_view _path);
    static VFSConfiguration ComposeConfiguration(const std::string &_server,
                                                 const std::string &_user,
                                                 const std::string &_passwd,
                                                 bool _https,
                                                 int _rest_port,
                                                 int _proxy_port);

    struct State;
    std::unique_ptr<State> I;
    VFSConfiguration m_Configuration;
};

} // namespace nc::vfs

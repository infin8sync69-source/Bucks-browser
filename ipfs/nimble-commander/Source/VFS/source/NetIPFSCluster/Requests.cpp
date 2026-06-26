// Copyright (C) 2026 Michael Kazakov. Subject to GNU General Public License version 3.
#include "Requests.h"
#include "Connection.h"
#include "ReadBuffer.h"
#include "PathRoutines.h"
#include <nlohmann/json.hpp>
#include <ctime>

namespace nc::vfs::ipfs_cluster {

using json = nlohmann::json;

static time_t ParseISO8601(const std::string &_str)
{
    // Cluster timestamps look like "2026-06-12T13:17:42.123+05:30"; sub-second
    // precision and zone offset are ignored, which is fine for display purposes.
    std::tm tm = {};
    if( strptime(_str.c_str(), "%Y-%m-%dT%H:%M:%S", &tm) == nullptr )
        return -1;
    return timegm(&tm);
}

static std::expected<std::string, Error>
Perform(Connection &_connection, std::string_view _method, const std::string &_url)
{
    if( const std::expected<void, Error> rc = _connection.SetCustomRequest(_method); !rc )
        return std::unexpected(rc.error());
    if( const std::expected<void, Error> rc = _connection.SetURL(_url); !rc )
        return std::unexpected(rc.error());
    const std::expected<int, Error> http_code = _connection.PerformBlockingRequest();
    if( !http_code )
        return std::unexpected(http_code.error());
    if( const std::optional<Error> err = HTTPRCToError(*http_code) )
        return std::unexpected(*err);
    return _connection.ResponseBody().ReadAllAsString();
}

std::expected<std::vector<PinInfo>, Error> RequestPins(const HostConfiguration &_options, Connection &_connection)
{
    const auto url = _options.rest_url + "pins";
    const std::expected<std::string, Error> response = Perform(_connection, "GET", url);
    if( !response )
        return std::unexpected(response.error());

    // the response is NDJSON - one pin status object per line
    std::vector<PinInfo> pins;
    size_t pos = 0;
    const std::string &body = *response;
    while( pos < body.size() ) {
        size_t eol = body.find('\n', pos);
        if( eol == std::string::npos )
            eol = body.size();
        const std::string_view line(body.data() + pos, eol - pos);
        pos = eol + 1;
        if( line.find_first_not_of(" \t\r") == std::string_view::npos )
            continue;
        const json obj = json::parse(line, nullptr, false);
        if( obj.is_discarded() || !obj.is_object() )
            continue;
        PinInfo pin;
        if( obj.contains("cid") ) {
            const auto &cid = obj["cid"];
            if( cid.is_string() ) // modern API: "cid": "Qm..."
                pin.cid = cid.get<std::string>();
            else if( cid.is_object() && cid.contains("/") ) // legacy: "cid": {"/": "Qm..."}
                pin.cid = cid["/"].get<std::string>();
        }
        if( pin.cid.empty() )
            continue;
        if( obj.contains("name") && obj["name"].is_string() )
            pin.name = obj["name"].get<std::string>();
        if( obj.contains("created") && obj["created"].is_string() )
            pin.created = ParseISO8601(obj["created"].get<std::string>());
        pins.push_back(std::move(pin));
    }
    return pins;
}

std::expected<EntryInfo, Error>
RequestStat(const HostConfiguration &_options, Connection &_connection, const std::string &_cid_path)
{
    const auto url = _options.proxy_url + "api/v0/files/stat?arg=" + URIEscape("/ipfs/" + _cid_path);
    const std::expected<std::string, Error> response = Perform(_connection, "POST", url);
    if( !response )
        return std::unexpected(response.error());

    const json obj = json::parse(*response, nullptr, false);
    if( obj.is_discarded() || !obj.is_object() )
        return std::unexpected(Error{Error::POSIX, EBADMSG});

    EntryInfo info;
    if( const auto slash = _cid_path.find_last_of('/'); slash != std::string::npos )
        info.filename = _cid_path.substr(slash + 1);
    else
        info.filename = _cid_path;
    if( obj.contains("Hash") && obj["Hash"].is_string() )
        info.cid = obj["Hash"].get<std::string>();
    if( obj.contains("Type") && obj["Type"].is_string() )
        info.is_directory = obj["Type"].get<std::string>() == "directory";
    if( obj.contains("Size") && obj["Size"].is_number() )
        info.size = info.is_directory ? -1 : obj["Size"].get<long>();
    return info;
}

std::expected<std::vector<EntryInfo>, Error>
RequestUnixFSListing(const HostConfiguration &_options, Connection &_connection, const std::string &_cid_path)
{
    const auto url = _options.proxy_url + "api/v0/ls?arg=" + URIEscape(_cid_path);
    const std::expected<std::string, Error> response = Perform(_connection, "POST", url);
    if( !response )
        return std::unexpected(response.error());

    const json obj = json::parse(*response, nullptr, false);
    if( obj.is_discarded() || !obj.is_object() || !obj.contains("Objects") || !obj["Objects"].is_array() ||
        obj["Objects"].empty() )
        return std::unexpected(Error{Error::POSIX, EBADMSG});

    std::vector<EntryInfo> entries;
    const auto &links = obj["Objects"][0]["Links"];
    if( !links.is_array() )
        return entries;
    for( const auto &link : links ) {
        EntryInfo e;
        if( link.contains("Name") && link["Name"].is_string() )
            e.filename = link["Name"].get<std::string>();
        if( link.contains("Hash") && link["Hash"].is_string() )
            e.cid = link["Hash"].get<std::string>();
        if( e.filename.empty() || e.cid.empty() )
            continue;
        const int type = link.contains("Type") && link["Type"].is_number() ? link["Type"].get<int>() : 2;
        e.is_directory = type == 1;
        if( !e.is_directory && link.contains("Size") && link["Size"].is_number() )
            e.size = link["Size"].get<long>();
        entries.push_back(std::move(e));
    }
    return entries;
}

std::expected<void, Error>
RequestUnpin(const HostConfiguration &_options, Connection &_connection, const std::string &_cid)
{
    const auto url = _options.rest_url + "pins/" + _cid;
    const std::expected<std::string, Error> response = Perform(_connection, "DELETE", url);
    if( !response )
        return std::unexpected(response.error());
    return {};
}

std::expected<void, Error> RequestRepinWithName(const HostConfiguration &_options,
                                                Connection &_connection,
                                                const std::string &_cid,
                                                const std::string &_name)
{
    const auto url = _options.rest_url + "pins/" + _cid + "?name=" + URIEscape(_name);
    const std::expected<std::string, Error> response = Perform(_connection, "POST", url);
    if( !response )
        return std::unexpected(response.error());
    return {};
}

} // namespace nc::vfs::ipfs_cluster

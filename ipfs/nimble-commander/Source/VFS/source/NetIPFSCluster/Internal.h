// Copyright (C) 2026 Michael Kazakov. Subject to GNU General Public License version 3.
#pragma once

#include <string>
#include <sys/stat.h>
#include <Base/Error.h>
#include <optional>

namespace nc::vfs::ipfs_cluster {

class Connection;

class HostConfiguration
{
public:
    std::string server;       // hostname or IP of a cluster peer
    std::string user;         // optional basic auth
    std::string passwd;       // optional basic auth
    std::string verbose;      // cached only. not counted in operator ==
    std::string rest_url;     // http[s]://server:rest_port/  - cluster REST API
    std::string proxy_url;    // http[s]://server:proxy_port/ - cluster IPFS proxy (/api/v0)
    bool https = false;
    int port = 9094;       // cluster REST API port, doubles as CURLConnection's port hint
    int proxy_port = 9095; // cluster IPFS proxy port

    static const char *Tag();
    [[nodiscard]] const char *Junction() const;
    [[nodiscard]] const char *VerboseJunction() const;
    bool operator==(const HostConfiguration &_rhs) const;
};

// A single entry in the VFS: at root - a cluster pin, below root - a UnixFS node.
struct EntryInfo {
    std::string filename;
    std::string cid; // CID of this entry itself
    long size = -1;
    time_t creation_date = -1;
    time_t modification_date = -1;
    bool is_directory = false;
};

constexpr uint16_t DirectoryAccessMode = S_IRUSR | S_IWUSR | S_IFDIR | S_IXUSR;
constexpr uint16_t RegularFileAccessMode = S_IRUSR | S_IWUSR | S_IFREG;

std::optional<Error> ToError(int _curl_rc, int _http_rc) noexcept;
std::optional<Error> CurlRCToError(int _curl_rc) noexcept;
std::optional<Error> HTTPRCToError(int _http_rc) noexcept;
bool IsOkHTTPRC(int _rc);

} // namespace nc::vfs::ipfs_cluster

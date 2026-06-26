// Copyright (C) 2026 Michael Kazakov. Subject to GNU General Public License version 3.
#pragma once

#include "Internal.h"
#include <vector>

namespace nc::vfs::ipfs_cluster {

class Connection;

// A pin tracked by the cluster, i.e. an entry of the VFS root directory.
struct PinInfo {
    std::string cid;
    std::string name;
    time_t created = -1;
};

// GET {rest}/pins - the cluster pinset. NDJSON, one GlobalPinInfo per line.
std::expected<std::vector<PinInfo>, Error> RequestPins(const HostConfiguration &_options, Connection &_connection);

// POST {proxy}/api/v0/files/stat?arg=/ipfs/<cid_path> - size/type of any IPFS path.
std::expected<EntryInfo, Error>
RequestStat(const HostConfiguration &_options, Connection &_connection, const std::string &_cid_path);

// POST {proxy}/api/v0/ls?arg=<cid_path> - children of a UnixFS directory.
std::expected<std::vector<EntryInfo>, Error>
RequestUnixFSListing(const HostConfiguration &_options, Connection &_connection, const std::string &_cid_path);

// DELETE {rest}/pins/<cid> - unpin from the whole cluster.
std::expected<void, Error>
RequestUnpin(const HostConfiguration &_options, Connection &_connection, const std::string &_cid);

// POST {rest}/pins/<cid>?name=<name> - re-pin an existing CID under a new name.
std::expected<void, Error> RequestRepinWithName(const HostConfiguration &_options,
                                                Connection &_connection,
                                                const std::string &_cid,
                                                const std::string &_name);

} // namespace nc::vfs::ipfs_cluster

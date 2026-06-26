// Copyright (C) 2017-2024 Michael Kazakov. Subject to GNU General Public License version 3.
#pragma once

#include <string>

namespace nc::vfs::ipfs_cluster {

class HostConfiguration;

std::pair<std::string, std::string> DeconstructPath(std::string_view _path); // {"/directory/", "filename"}
std::string URIEscape(std::string_view _unescaped);
std::string URIUnescape(const std::string &_escaped);

} // namespace nc::vfs::ipfs_cluster

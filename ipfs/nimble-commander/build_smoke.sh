set -e
# Builds the standalone NetIPFSCluster smoke harness with Command Line Tools only.
# Usage: bash build_smoke.sh && /tmp/smoke_ipfs
cd /Users/mikado/new/folder/nimble-commander
clang++ -std=c++23 -fobjc-arc -g -O0 \
  -I. -ISource/Base/include -ISource/Utility/include -ISource/VFS/include \
  -I3rd_Party/nlohmann/include -I3rd_Party/fmt/include -I3rd_Party/libcurl/include \
  -I3rd_Party/unordered_dense/include -I3rd_Party/boost/include -I3rd_Party/magic_enum/include -I3rd_Party/frozen/include -I3rd_Party/spdlog/include \
  smoke_ipfs.mm \
  Source/VFS/source/NetIPFSCluster/CURLConnection.cpp \
  Source/VFS/source/NetIPFSCluster/Connection.cpp \
  Source/VFS/source/NetIPFSCluster/ConnectionsPool.cpp \
  Source/VFS/source/NetIPFSCluster/Internal.cpp \
  Source/VFS/source/NetIPFSCluster/Requests.cpp \
  Source/VFS/source/NetIPFSCluster/ReadBuffer.cpp \
  Source/VFS/source/NetIPFSCluster/WriteBuffer.cpp \
  Source/VFS/source/NetIPFSCluster/PathRoutines.mm \
  Source/Utility/source/StringExtras.mm \
  Source/Base/source/Error.mm Source/Base/source/mach_time.cpp Source/Base/source/spinlock.cpp \
  -L3rd_Party/libcurl/lib -lcurl -L3rd_Party/OpenSSL/lib -lssl -lcrypto -L3rd_Party/libssh2/lib -lssh2 \
  -framework Foundation -framework CFNetwork -framework SystemConfiguration -framework Security -framework CoreFoundation \
  -liconv -licucore -lz "$(ls /opt/homebrew/lib/libzstd.a 2>/dev/null || echo -lzstd)" \
  -o /tmp/smoke_ipfs

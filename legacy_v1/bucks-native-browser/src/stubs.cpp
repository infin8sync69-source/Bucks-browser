#include "blockchain.h"
#include "utxo.h"
#include "utxodb.h"

namespace Bucks {

// Minimal stubs to satisfy the linker for wallet.cpp
// The browser will use RPC to talk to the real node for these values.

const UTXODB &Blockchain::utxo() const {
  static UTXODB dummyUtxo("");
  return dummyUtxo;
}

std::vector<UTXO> UTXODB::getUTXOsByAddress(const std::string &address) const {
  return {}; // Return empty for now
}

// Ensure UTXODB has a constructor and destructor we can link to
UTXODB::UTXODB(const std::string &path) {}
UTXODB::~UTXODB() {}
bool UTXODB::init() { return true; }

// Blockchain stub
Blockchain::Blockchain(const std::string &, const std::string &) {}

} // namespace Bucks

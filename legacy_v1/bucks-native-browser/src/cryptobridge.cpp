#include "cryptobridge.h"
#include "bip_8192.h"
#include "crypto.h"
#include <iostream>

CryptoBridge::CryptoBridge(QObject *parent) : QObject(parent) {}

QString CryptoBridge::address() const {
  return QString::fromStdString(m_wallet.getAddress());
}

QString CryptoBridge::mnemonic() const {
  return QString::fromStdString(m_wallet.getMnemonic());
}

void CryptoBridge::createWallet() {
  m_wallet.generateKeys();
  emit addressChanged();
  emit mnemonicChanged();
  emit walletCreated();
}

bool CryptoBridge::restoreWallet(const QString &mnemonic,
                                 const QString &passphrase) {
  try {
    m_wallet.restoreFromMnemonic(mnemonic.toStdString(),
                                 passphrase.toStdString());
    emit addressChanged();
    emit mnemonicChanged();
    emit walletCreated();
    return true;
  } catch (const std::exception &e) {
    std::cerr << "Restore failed: " << e.what() << std::endl;
    return false;
  }
}

QString CryptoBridge::getPrivateKey() const {
  return QString::fromStdString(m_wallet.getPrivateKeyHex());
}

QString CryptoBridge::getPublicKey() const {
  return QString::fromStdString(m_wallet.getPublicKeyHex());
}

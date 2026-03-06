#ifndef CRYPTOBRIDGE_H
#define CRYPTOBRIDGE_H

#include "wallet.h"
#include <QObject>
#include <QString>

class CryptoBridge : public QObject {
  Q_OBJECT
  Q_PROPERTY(QString address READ address NOTIFY addressChanged)
  Q_PROPERTY(QString mnemonic READ mnemonic NOTIFY mnemonicChanged)

public:
  explicit CryptoBridge(QObject *parent = nullptr);

  QString address() const;
  QString mnemonic() const;

  // QML-invokable methods
  Q_INVOKABLE void createWallet();
  Q_INVOKABLE bool restoreWallet(const QString &mnemonic,
                                 const QString &passphrase = "");

  // Key retrieval (Hex)
  Q_INVOKABLE QString getPrivateKey() const;
  Q_INVOKABLE QString getPublicKey() const;

signals:
  void addressChanged();
  void mnemonicChanged();
  void walletCreated();

private:
  Bucks::Wallet m_wallet;
};

#endif // CRYPTOBRIDGE_H

#ifndef SLMINTERFACE_H
#define SLMINTERFACE_H

#include <QObject>
#include <QString>
#include <QVariantMap>

class SlmInterface : public QObject {
  Q_OBJECT
  Q_PROPERTY(bool isProcessing READ isProcessing NOTIFY isProcessingChanged)
  Q_PROPERTY(bool isModelLoaded READ isModelLoaded NOTIFY isModelLoadedChanged)

public:
  explicit SlmInterface(QObject *parent = nullptr);

  bool isProcessing() const { return m_isProcessing; }
  bool isModelLoaded() const { return m_isModelLoaded; }

public slots:
  void query(const QString &prompt);
  void loadModel(const QString &modelPath);
  void cancelInference();

signals:
  void tokenReceived(const QString &token);
  void inferenceComplete(const QString &fullResponse);
  void errorOccurred(const QString &error);
  void isProcessingChanged();
  void isModelLoadedChanged();
  void downloadProgress(float progress);

private:
  bool m_isProcessing = false;
  bool m_isModelLoaded = false;
};

#endif // SLMINTERFACE_H

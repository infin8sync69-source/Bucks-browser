#include "slminterface.h"
#include <QDebug>
#include <QTimer>

SlmInterface::SlmInterface(QObject *parent) : QObject(parent) {}

void SlmInterface::query(const QString &prompt) {
  if (m_isProcessing)
    return;

  m_isProcessing = true;
  emit isProcessingChanged();

  qDebug() << "SLM Query:" << prompt;

  // Simulated local inference for now
  // In a real implementation, this would call into llama.cpp or similar
  QTimer::singleShot(500, this, [this, prompt]() {
    QString response = "I am the Bucks AI. You asked about: " + prompt;
    // Simulating token streaming
    QStringList tokens = response.split(" ");
    for (int i = 0; i < tokens.size(); ++i) {
      QTimer::singleShot(100 * (i + 1), this,
                         [this, token = tokens[i],
                          isLast = (i == tokens.size() - 1), response]() {
                           emit tokenReceived(token + " ");
                           if (isLast) {
                             m_isProcessing = false;
                             emit isProcessingChanged();
                             emit inferenceComplete(response);
                           }
                         });
    }
  });
}

void SlmInterface::loadModel(const QString &modelPath) {
  qDebug() << "Loading SLM model from:" << modelPath;
  // Simulate model loading
  QTimer::singleShot(2000, this, [this]() {
    m_isModelLoaded = true;
    emit isModelLoadedChanged();
  });
}

void SlmInterface::cancelInference() {
  m_isProcessing = false;
  emit isProcessingChanged();
}

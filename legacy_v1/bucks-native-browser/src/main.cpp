#include "cryptobridge.h"
#include "slminterface.h"
#include <QApplication>
#include <QCoreApplication>
#include <QFontDatabase>
#include <QQmlApplicationEngine>
#include <QQmlContext>
#include <QQuickWindow>
#include <QString>
#include <QUrl>
#include <QtWebEngineQuick/qtwebenginequickglobal.h>

int main(int argc, char *argv[]) {
  // Set style to Basic to allow customization
  qputenv("QT_QUICK_CONTROLS_STYLE", "Basic");

  // Required for Qt WebEngine in Quick
  QtWebEngineQuick::initialize();

  // Enable High DPI scaling
  QCoreApplication::setAttribute(Qt::AA_EnableHighDpiScaling);

  QApplication app(argc, argv);

  // Load Premium Fonts
  QFontDatabase::addApplicationFont(
      "/Users/mikado/Desktop/Bucks-browser/bucks-native-browser/src/assets/"
      "fonts/Outfit-Bold.ttf");
  QFontDatabase::addApplicationFont(
      "/Users/mikado/Desktop/Bucks-browser/bucks-native-browser/src/assets/"
      "fonts/Inter-Regular.ttf");
  QFontDatabase::addApplicationFont(
      "/Users/mikado/Desktop/Bucks-browser/bucks-native-browser/src/assets/"
      "fonts/MaterialIcons-Regular.ttf");

  CryptoBridge cryptoBridge;
  SlmInterface slmInterface;

  QQmlApplicationEngine engine;
  engine.rootContext()->setContextProperty("cryptoBridge", &cryptoBridge);
  engine.rootContext()->setContextProperty("slmInterface", &slmInterface);

  const QUrl url(QStringLiteral("qrc:/qt/qml/BucksNativeBrowser/main.qml"));

  // For now, load from local file until we set up resources
  engine.load(QUrl::fromLocalFile(
      "/Users/mikado/Desktop/Bucks-browser/bucks-native-browser/src/main.qml"));

  if (engine.rootObjects().isEmpty())
    return -1;

  QObject *root = engine.rootObjects().first();
  QQuickWindow *qWindow = qobject_cast<QQuickWindow *>(root);
  if (qWindow) {
    qWindow->show();
    qWindow->raise();
    qWindow->requestActivate();
  }

  return app.exec();
}

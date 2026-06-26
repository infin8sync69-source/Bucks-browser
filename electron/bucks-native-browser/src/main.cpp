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
#include <QDir>
#include <QDebug>

int main(int argc, char *argv[]) {
  // Set style to Basic to allow customization
  qputenv("QT_QUICK_CONTROLS_STYLE", "Basic");

  // Required for Qt WebEngine in Quick
  QtWebEngineQuick::initialize();

  // Enable High DPI scaling
  QCoreApplication::setAttribute(Qt::AA_EnableHighDpiScaling);

  QApplication app(argc, argv);

  // Resolve base directory dynamically
  QString baseDir;
  if (qEnvironmentVariableIsSet("BUCKS_NATIVE_DIR")) {
    baseDir = qgetenv("BUCKS_NATIVE_DIR");
  } else {
    QString appDir = QCoreApplication::applicationDirPath();
    QDir dir(appDir);
    if (dir.dirName() == "build" || dir.dirName() == "Debug" || dir.dirName() == "Release") {
      dir.cdUp();
      baseDir = dir.absolutePath();
    } else if (dir.exists("src/main.qml")) {
      baseDir = dir.absolutePath();
    } else {
      while (dir.cdUp()) {
        if (dir.exists("bucks-native-browser/src/main.qml")) {
          dir.cd("bucks-native-browser");
          baseDir = dir.absolutePath();
          break;
        } else if (dir.exists("src/main.qml")) {
          baseDir = dir.absolutePath();
          break;
        }
      }
    }
    if (baseDir.isEmpty()) {
      baseDir = QDir::currentPath();
    }
  }

  qDebug() << "[NativeBrowser] Resolved base assets directory:" << baseDir;

  // Load Premium Fonts
  QFontDatabase::addApplicationFont(baseDir + "/src/assets/fonts/Outfit-Bold.ttf");
  QFontDatabase::addApplicationFont(baseDir + "/src/assets/fonts/Inter-Regular.ttf");
  QFontDatabase::addApplicationFont(baseDir + "/src/assets/fonts/MaterialIcons-Regular.ttf");

  CryptoBridge cryptoBridge;
  SlmInterface slmInterface;

  QQmlApplicationEngine engine;
  engine.rootContext()->setContextProperty("cryptoBridge", &cryptoBridge);
  engine.rootContext()->setContextProperty("slmInterface", &slmInterface);

  const QUrl url(QStringLiteral("qrc:/qt/qml/BucksNativeBrowser/main.qml"));

  // For now, load from local file until we set up resources
  engine.load(QUrl::fromLocalFile(baseDir + "/src/main.qml"));

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

#ifndef MAINWINDOW_H
#define MAINWINDOW_H

#include <QLineEdit>
#include <QMainWindow>
#include <QPushButton>
#include <QWebEngineView>

class MainWindow : public QMainWindow {
  Q_OBJECT

public:
  explicit MainWindow(QWidget *parent = nullptr);
  ~MainWindow();

private slots:
  void navigateToUrl();
  void updateUrlBox(const QUrl &url);

private:
  QWebEngineView *m_webView;
  QLineEdit *m_urlEdit;
  QPushButton *m_backButton;
  QPushButton *m_forwardButton;
  QPushButton *m_reloadButton;

  void setupUi();
};

#endif // MAINWINDOW_H

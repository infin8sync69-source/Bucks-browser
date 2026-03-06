#include "mainwindow.h"
#include <QHBoxLayout>
#include <QUrl>
#include <QVBoxLayout>
#include <QWidget>

MainWindow::MainWindow(QWidget *parent) : QMainWindow(parent) {
  setupUi();

  // Connect URL bar
  connect(m_urlEdit, &QLineEdit::returnPressed, this,
          &MainWindow::navigateToUrl);

  // Connect WebEngineView url changes back to the text box
  connect(m_webView, &QWebEngineView::urlChanged, this,
          &MainWindow::updateUrlBox);

  // Load initial page
  m_webView->setUrl(QUrl("https://search.brave.com"));
}

MainWindow::~MainWindow() {}

void MainWindow::setupUi() {
  QWidget *centralWidget = new QWidget(this);
  setCentralWidget(centralWidget);

  QVBoxLayout *mainLayout = new QVBoxLayout(centralWidget);
  mainLayout->setContentsMargins(0, 0, 0, 0);
  mainLayout->setSpacing(0);

  // Top Navigation Bar
  QWidget *navBar = new QWidget(this);
  QHBoxLayout *navLayout = new QHBoxLayout(navBar);
  navLayout->setContentsMargins(8, 8, 8, 8);

  m_backButton = new QPushButton("<", this);
  m_forwardButton = new QPushButton(">", this);
  m_reloadButton = new QPushButton("C", this);
  m_urlEdit = new QLineEdit(this);

  navLayout->addWidget(m_backButton);
  navLayout->addWidget(m_forwardButton);
  navLayout->addWidget(m_reloadButton);
  navLayout->addWidget(m_urlEdit);

  // Web View
  m_webView = new QWebEngineView(this);

  // Add to main layout
  mainLayout->addWidget(navBar);
  mainLayout->addWidget(m_webView);

  // Connect standard browser buttons
  connect(m_backButton, &QPushButton::clicked, m_webView,
          &QWebEngineView::back);
  connect(m_forwardButton, &QPushButton::clicked, m_webView,
          &QWebEngineView::forward);
  connect(m_reloadButton, &QPushButton::clicked, m_webView,
          &QWebEngineView::reload);
}

void MainWindow::navigateToUrl() {
  QString urlStr = m_urlEdit->text();
  if (!urlStr.startsWith("http://") && !urlStr.startsWith("https://")) {
    urlStr = "https://" + urlStr;
  }
  m_webView->setUrl(QUrl(urlStr));
}

void MainWindow::updateUrlBox(const QUrl &url) {
  m_urlEdit->setText(url.toString());
}

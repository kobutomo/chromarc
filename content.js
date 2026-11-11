// 変更されたタブ名を document.title に反映し、ページ側が書き換えても維持する
(() => {
  // 拡張機能を再読み込みすると、開いたままのページには古い content script が残る。
  // 古い方を止めて状態を引き継ぐ (フラグで二重実行を弾くと、再読み込み後に何も効かなくなる)
  const previous = window.__chromarcDispose?.() ?? null;

  let custom = previous?.custom ?? null;
  let original = previous?.original ?? null;
  let observer = null;
  let disposed = false;

  function alive() {
    try {
      return !disposed && !!chrome.runtime?.id;
    } catch {
      return false;
    }
  }

  function start() {
    if (observer) return;
    // 名前を変えたタブでだけ監視する
    observer = new MutationObserver(enforce);
    observer.observe(document, { childList: true, subtree: true });
  }

  function stop() {
    observer?.disconnect();
    observer = null;
  }

  function enforce() {
    if (!alive()) {
      stop();
      return;
    }
    if (custom !== null && document.title !== custom) {
      original = document.title;
      document.title = custom;
    }
  }

  // name: 文字列なら設定 (空文字は「名前なし」)、null なら元のタイトルに戻す
  function setName(name) {
    if (name !== null && name !== undefined) {
      // 空文字や空白だけのタイトルだと Chrome が URL を表示するので、空白に見える文字を入れる
      const title = name === '' ? '\u2800' : name;
      if (custom === null || document.title !== custom) original = document.title;
      custom = title;
      document.title = title;
      start();
    } else if (custom !== null) {
      stop();
      custom = null;
      document.title = original ?? '';
    }
  }

  window.__chromarcDispose = () => {
    disposed = true;
    stop();
    return { custom, original };
  };

  if (custom !== null) start();

  chrome.runtime.onMessage.addListener((message) => {
    if (disposed) return;
    if (message?.type === 'setName') setName(message.name);
  });

  chrome.runtime.sendMessage({ type: 'getName' }, (response) => {
    if (chrome.runtime.lastError || disposed) return;
    setName(response?.name ?? null);
  });
})();

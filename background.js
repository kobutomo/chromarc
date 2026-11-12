importScripts('shared.js');

const ALARM = 'archive';

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.alarms.get(ALARM, (alarm) => {
  if (!alarm) chrome.alarms.create(ALARM, { periodInMinutes: 1 });
});

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    // インストール直後に古いタブが一斉に閉じられないよう、経過時間の起点を記録する
    await chrome.storage.local.set({ baseline: Date.now() });
  }
  chrome.contextMenus.create(
    { id: 'rename', title: 'このタブの名前を変更…', contexts: ['page', 'action'] },
    () => void chrome.runtime.lastError,
  );
  chrome.contextMenus.create(
    { id: 'reset-name', title: 'このタブの名前を元に戻す', contexts: ['page', 'action'] },
    () => void chrome.runtime.lastError,
  );
});

// ---------------------------------------------------------------- タブ名の変更

// rawName: 文字列なら名前を設定 (空文字は「名前なし」)、null なら元のタイトルに戻す
async function setRename(tabId, rawName) {
  const name = rawName == null ? null : String(rawName).trim();
  const { renames = {} } = await chrome.storage.local.get('renames');
  if (name !== null) {
    const tab = await chrome.tabs.get(tabId);
    renames[tabId] = { name, url: tab.url };
  } else {
    delete renames[tabId];
  }
  await chrome.storage.local.set({ renames });

  try {
    await chrome.tabs.sendMessage(tabId, { type: 'setName', name });
  } catch {
    // インストール前から開いていたタブには content script が居ないので注入する
    // (注入された content script は自分で名前を問い合わせる)
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    } catch {
      // chrome:// などスクリプトを注入できないページ。サイドバー上の表示だけ変わる
    }
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'getName') {
    chrome.storage.local.get('renames').then(({ renames = {} }) => {
      sendResponse({ name: renames[sender.tab?.id]?.name ?? null });
    });
    return true;
  }
  if (message?.type === 'awsAccount') {
    const tabId = sender.tab?.id;
    if (tabId == null) return;
    chrome.storage.session.get('awsAccounts').then(({ awsAccounts = {} }) => {
      const current = awsAccounts[tabId];
      if (current?.id === message.id && current?.alias === message.alias) return;
      awsAccounts[tabId] = { id: message.id, alias: message.alias ?? null };
      return chrome.storage.session.set({ awsAccounts });
    });
    return;
  }
  if (message?.type === 'refreshReviews') {
    fetchReviews().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message?.type === 'clear') {
    clearTabs(message.windowId).then(
      () => sendResponse({ ok: true }),
      (error) => sendResponse({ ok: false, error: String(error) }),
    );
    return true;
  }
  if (message?.type === 'rename') {
    setRename(message.tabId, message.name).then(
      () => sendResponse({ ok: true }),
      (error) => sendResponse({ ok: false, error: String(error) }),
    );
    return true;
  }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (tab?.id == null) return;
  if (info.menuItemId === 'reset-name') {
    await setRename(tab.id, null);
    return;
  }
  if (info.menuItemId !== 'rename') return;
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (current) => prompt('タブの名前(空にすると名前なしになります)', current),
      args: [stripBlank(tab.title)],
    });
    if (result !== null) await setRename(tab.id, result);
  } catch {
    // スクリプトを注入できないページではサイドバーから変更してもらう
  }
});

// 変更した名前はページ遷移しても維持する。再起動後の復元用に URL だけ追従させる
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (!changeInfo.url) return;
  const { renames = {} } = await chrome.storage.local.get('renames');
  if (!renames[tabId]) return;
  renames[tabId].url = changeInfo.url;
  await chrome.storage.local.set({ renames });
});

chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
  const { links = {} } = await chrome.storage.session.get('links');
  const bookmarkId = Object.keys(links).find((id) => links[id] === tabId);
  if (bookmarkId) {
    delete links[bookmarkId];
    await chrome.storage.session.set({ links });
  }

  const { awsAccounts = {} } = await chrome.storage.session.get('awsAccounts');
  if (awsAccounts[tabId]) {
    delete awsAccounts[tabId];
    await chrome.storage.session.set({ awsAccounts });
  }

  // ウィンドウごと閉じた場合は、再起動時に URL で引き継げるよう残しておく
  if (removeInfo.isWindowClosing) return;
  const { renames = {} } = await chrome.storage.local.get('renames');
  if (renames[tabId]) {
    delete renames[tabId];
    await chrome.storage.local.set({ renames });
  }
});

// ブラウザを再起動するとタブ ID が変わるので、URL を手がかりに名前を引き継ぐ
chrome.runtime.onStartup.addListener(async () => {
  const { renames = {} } = await chrome.storage.local.get('renames');
  const entries = Object.values(renames);
  if (entries.length === 0) return;
  const tabs = await chrome.tabs.query({});
  const used = new Set();
  const next = {};
  for (const entry of entries) {
    const tab = tabs.find((t) => !used.has(t.id) && (t.url || t.pendingUrl) === entry.url);
    if (!tab) continue;
    used.add(tab.id);
    next[tab.id] = entry;
  }
  await chrome.storage.local.set({ renames: next });
});

// ブックマークから開いたタブの favicon が決まったら、そのブックマーク用に覚えておく
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (!changeInfo.favIconUrl) return;
  const { links = {} } = await chrome.storage.session.get('links');
  const bookmarkId = Object.keys(links).find((id) => links[id] === tabId);
  if (bookmarkId) await saveBookmarkFavicon(bookmarkId, changeInfo.favIconUrl);
});

// ブックマークが削除されたら、開いていたタブとの紐付けを外す (タブは通常のタブに戻る)
chrome.bookmarks.onRemoved.addListener(async (id, removeInfo) => {
  const removed = [];
  (function collect(node) {
    if (!node) return;
    removed.push(node.id);
    for (const child of node.children ?? []) collect(child);
  })(removeInfo.node ?? { id });
  const { links = {} } = await chrome.storage.session.get('links');
  const stale = removed.filter((bookmarkId) => bookmarkId in links);
  if (stale.length > 0) {
    for (const bookmarkId of stale) delete links[bookmarkId];
    await chrome.storage.session.set({ links });
  }

  const { favicons = {} } = await chrome.storage.local.get('favicons');
  const staleIcons = removed.filter((bookmarkId) => bookmarkId in favicons);
  if (staleIcons.length > 0) {
    for (const bookmarkId of staleIcons) delete favicons[bookmarkId];
    await chrome.storage.local.set({ favicons });
  }

  // 分割ビューとして登録したブックマークの相方の URL も消す
  const { splitBookmarks = {} } = await chrome.storage.local.get('splitBookmarks');
  const staleSplits = removed.filter((bookmarkId) => bookmarkId in splitBookmarks);
  if (staleSplits.length > 0) {
    for (const bookmarkId of staleSplits) delete splitBookmarks[bookmarkId];
    await chrome.storage.local.set({ splitBookmarks });
  }
});

// ------------------------------------------------- GitHub のレビュー依頼

const REVIEWS_ALARM = 'reviews';

chrome.alarms.get(REVIEWS_ALARM, (alarm) => {
  if (!alarm) chrome.alarms.create(REVIEWS_ALARM, { periodInMinutes: 5 });
});

// トークンがあれば GitHub API で取得する (確実)
async function fetchPrsFromApi(token, query) {
  const url = `https://api.github.com/search/issues?per_page=100&q=${encodeURIComponent(query)}`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
  });
  if (!response.ok) throw new Error(`GitHub API がエラーを返しました (${response.status})`);
  const { items = [] } = await response.json();
  return items.map((item) => ({
    url: item.html_url,
    title: item.title,
    repo: item.repository_url?.split('/repos/')[1] ?? '',
    number: item.number,
  }));
}

const decodeEntities = (text) =>
  text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');

// トークンがなければ、ログイン中のセッションでページを取得して PR へのリンクを拾う
async function fetchPrsFromPage(pageUrl) {
  const response = await fetch(pageUrl, { credentials: 'include' });
  if (/^\/(login|session)/.test(new URL(response.url).pathname)) {
    throw new Error('GitHub にログインしていません');
  }
  if (!response.ok) throw new Error(`GitHub のページを取得できませんでした (${response.status})`);
  const html = await response.text();

  const found = new Map();
  const add = (owner, repo, number, title) => {
    const key = `${owner}/${repo}#${number}`;
    const current = found.get(key);
    if (current && (current.title || !title)) return;
    found.set(key, {
      url: `https://github.com/${owner}/${repo}/pull/${number}`,
      title: title || '',
      repo: `${owner}/${repo}`,
      number: Number(number),
    });
  };
  // リンクとして埋まっている場合はタイトルも取れる
  const anchor =
    /<a\b[^>]*href="(?:https:\/\/github\.com)?\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)"[^>]*>([\s\S]*?)<\/a>/g;
  for (const [, owner, repo, number, inner] of html.matchAll(anchor)) {
    add(owner, repo, number, decodeEntities(inner.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim());
  }
  // 埋め込みデータなどに URL だけある場合は「owner/repo#番号」で表示する
  const bare = /github\.com\\?\/([\w.-]+)\\?\/([\w.-]+)\\?\/pull\\?\/(\d+)/g;
  for (const [, owner, repo, number] of html.matchAll(bare)) add(owner, repo, number, '');
  return [...found.values()];
}

async function fetchReviews() {
  const settings = await getSettings();
  if (!settings.reviewsEnabled) return;
  const { prLists = {} } = await chrome.storage.local.get('prLists');
  await Promise.all(
    PR_SOURCES.map(async (source) => {
      let items = prLists[source.key]?.items ?? [];
      let error = null;
      try {
        items = settings.githubToken
          ? await fetchPrsFromApi(settings.githubToken, source.query)
          : await fetchPrsFromPage(source.pageUrl);
      } catch (e) {
        error = String(e?.message ?? e); // 失敗時は前回の一覧を残す
      }
      prLists[source.key] = { items, error, fetchedAt: Date.now() };
    }),
  );
  await chrome.storage.local.set({ prLists });
}

chrome.runtime.onStartup.addListener(fetchReviews);
chrome.runtime.onInstalled.addListener(fetchReviews);

// 設定 (有効/無効・トークン) を変えたらすぐ取り直す
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  const before = changes.settings.oldValue ?? {};
  const after = changes.settings.newValue ?? {};
  if (before.reviewsEnabled !== after.reviewsEnabled || before.githubToken !== after.githubToken) {
    fetchReviews();
  }
});

// ------------------------------------------------------------ 自動アーカイブ

async function archiveTick() {
  const settings = await getSettings();
  const tabs = await chrome.tabs.query({});
  const now = Date.now();

  // 表示中・音声再生中のタブは「いま使っている」ものとして時刻を更新し続ける
  const session = await chrome.storage.session.get(['seen', 'links']);
  const seen = session.seen ?? {};
  const links = session.links ?? {};
  const alive = new Set(tabs.map((t) => String(t.id)));
  for (const id of Object.keys(seen)) {
    if (!alive.has(id)) delete seen[id];
  }
  for (const tab of tabs) {
    if (tab.active || tab.audible) seen[tab.id] = now;
  }
  await chrome.storage.session.set({ seen });

  if (!settings.archiveEnabled) return;
  const limit = Number(settings.archiveValue) * (UNIT_MS[settings.archiveUnit] ?? UNIT_MS.hours);
  if (!(limit > 0)) return;

  const { baseline = 0 } = await chrome.storage.local.get('baseline');
  const linked = linkedTabIdSet(links, tabs);

  // Arc と同様、ピン留め(ここではブックマークから開いたタブも含む)は対象外
  const victims = tabs.filter((tab) => {
    if (tab.active || tab.pinned || tab.audible || linked.has(tab.id) || isMeetingTab(tab)) return false;
    const lastUsed = Math.max(tab.lastAccessed ?? 0, seen[tab.id] ?? 0, baseline);
    return now - lastUsed >= limit;
  });
  await archiveTabs(victims);
}

// タブを閉じて「アーカイブ済み」に記録する
async function archiveTabs(tabs) {
  if (tabs.length === 0) return;
  const { renames = {}, archived = [] } = await chrome.storage.local.get(['renames', 'archived']);
  const now = Date.now();
  const records = tabs
    .filter((tab) => /^(https?|file|ftp):/.test(tab.url ?? ''))
    .map((tab) => ({
      title: renames[tab.id]?.name || stripBlank(tab.title) || tab.url,
      url: tab.url,
      favIconUrl: tab.favIconUrl ?? null,
      archivedAt: now,
    }));
  await chrome.storage.local.set({ archived: [...records, ...archived].slice(0, ARCHIVE_LIMIT) });
  await chrome.tabs.remove(tabs.map((tab) => tab.id)).catch(() => {});
}

// Arc の Clear: 表示中のタブ以外を閉じる (ピン留めとブックマークから開いたタブは残す)
async function clearTabs(windowId) {
  const [tabs, { links = {} }] = await Promise.all([
    chrome.tabs.query({ windowId }),
    chrome.storage.session.get('links'),
  ]);
  const linked = linkedTabIdSet(links, tabs);
  await archiveTabs(
    tabs.filter((tab) => !tab.active && !tab.pinned && !linked.has(tab.id) && !isMeetingTab(tab)),
  );
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) archiveTick();
  if (alarm.name === REVIEWS_ALARM) fetchReviews();
});

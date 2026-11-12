// background / sidepanel / options で共有する設定まわり

const DEFAULT_SETTINGS = {
  archiveEnabled: true,
  archiveValue: 12, // Arc の既定値は 12 時間
  archiveUnit: 'hours',
  fontSize: 13,
  bookmarkFolderId: null, // null = ブックマークバー
  reviewsEnabled: true, // GitHub のレビュー依頼を定期的に取得する
  githubToken: '', // 空ならログイン中のブラウザのセッションでページを取得する
};

const UNIT_MS = {
  minutes: 60 * 1000,
  hours: 60 * 60 * 1000,
  days: 24 * 60 * 60 * 1000,
};

const ARCHIVE_LIMIT = 200;

// 「名前なし」のタブに設定するタイトル。空文字や空白だけだと Chrome が URL を表示してしまうため、
// 空白として描画される文字 (点字の空白パターン) を使う
const BLANK_TITLE = '\u2800';
const stripBlank = (text) => (text ?? '').replaceAll(BLANK_TITLE, '');

// 分割ビュー (Chrome 155 以降の Split View API)。未対応の Chrome では常に null になる
const splitIdOf = (tab) =>
  typeof tab?.splitViewId === 'number' && tab.splitViewId !== -1 ? tab.splitViewId : null;

// ブックマークから開いたタブの ID 一覧。分割ビューの相方のタブも同じブックマークの一部として扱う
function linkedTabIdSet(links, tabs) {
  const ids = new Set(Object.values(links));
  const splits = new Set(
    tabs
      .filter((tab) => ids.has(tab.id))
      .map(splitIdOf)
      .filter((id) => id !== null),
  );
  for (const tab of tabs) {
    if (splits.has(splitIdOf(tab))) ids.add(tab.id);
  }
  return ids;
}

// ブックマークから開いたタブの favicon を覚えておく。
// (Chrome の favicon キャッシュは、リダイレクトされる URL などでは引けないことがある)
const usableFavicon = (url) => /^(https?:|data:)/.test(url ?? '') && url.length < 20000;

async function saveBookmarkFavicon(bookmarkId, favIconUrl) {
  if (!usableFavicon(favIconUrl)) return;
  const { favicons = {} } = await chrome.storage.local.get('favicons');
  if (favicons[bookmarkId] === favIconUrl) return;
  favicons[bookmarkId] = favIconUrl;
  await chrome.storage.local.set({ favicons });
}

// 会議中のタブ (Google Meet)。サイドバーでは「Current Meeting」にまとめ、自動アーカイブやクリアの対象外にする
function isMeetingTab(tab) {
  try {
    return new URL(tab.url ?? '').hostname === 'meet.google.com';
  } catch {
    return false;
  }
}

// AWS コンソールのタブ。サイドバーではアカウントごとのグループにまとめる
function awsHostOf(tab) {
  try {
    const { hostname } = new URL(tab.url ?? '');
    return hostname === 'console.aws.amazon.com' || hostname.endsWith('.console.aws.amazon.com')
      ? hostname
      : null;
  } catch {
    return null;
  }
}

// タブの AWS アカウント { id, alias }。分からなければ null。
// マルチセッション有効時の URL (123456789012-xxxx.region.console.aws.amazon.com) を優先し、
// なければページから読み取った情報 (aws.js が報告したもの) を使う
function awsAccountOf(tab, reported = {}) {
  const fromPage = reported[tab.id] ?? null;
  const fromUrl = awsHostOf(tab)?.match(/^(\d{12})-/)?.[1] ?? null;
  if (fromUrl) return { id: fromUrl, alias: fromPage?.id === fromUrl ? fromPage.alias : null };
  return fromPage;
}

// サイドバーに表示する GitHub の PR 一覧。
// pageUrl: トークンなしのときに取得するページ / query: トークンありのときの検索条件
const PR_SOURCES = [
  {
    key: 'reviews',
    title: 'Review Requests',
    pageUrl: 'https://github.com/pulls/reviews',
    query: 'is:open is:pr review-requested:@me archived:false',
  },
  {
    key: 'assigned',
    title: 'Assigned',
    pageUrl: 'https://github.com/pulls/assigned',
    query: 'is:open is:pr assignee:@me archived:false',
  },
];

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...settings };
}

async function saveSettings(patch) {
  const settings = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ settings });
  return settings;
}

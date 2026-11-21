const scope = 'https://www.googleapis.com/auth/drive.file';
const googleNativeTypes = [
  'application/vnd.google-apps.document',
  'application/vnd.google-apps.spreadsheet',
  'application/vnd.google-apps.presentation',
];
const pickerMimeTypes = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'text/plain',
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ...googleNativeTypes,
].join(',');

const scripts = new Map();

function loadScript(url) {
  if (scripts.has(url)) return scripts.get(url);
  const loading = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const fail = () => {
      clearTimeout(timer);
      script.remove();
      reject(new Error('Google Drive is unavailable.'));
    };
    const timer = setTimeout(fail, 12000);
    script.src = url;
    script.async = true;
    script.onload = () => {
      clearTimeout(timer);
      resolve();
    };
    script.onerror = fail;
    document.head.append(script);
  }).catch((error) => {
    scripts.delete(url);
    throw error;
  });
  scripts.set(url, loading);
  return loading;
}

let ready;
export function prepareDrivePicker() {
  ready ??= Promise.all([
    loadScript('https://apis.google.com/js/api.js').then(
      () =>
        new Promise((resolve, reject) =>
          window.gapi.load('picker', {
            callback: resolve,
            onerror: reject,
            timeout: 12000,
            ontimeout: reject,
          }),
        ),
    ),
    loadScript('https://accounts.google.com/gsi/client'),
  ])
    .then(() => pickDocument)
    .catch((error) => {
      ready = undefined;
      throw error;
    });
  return ready;
}

function getToken(config) {
  return new Promise((resolve, reject) => {
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: config.clientId,
      scope,
      include_granted_scopes: false,
      callback: (result) =>
        result.error || !result.access_token
          ? reject(new Error('Google Drive access was not granted.'))
          : resolve(result.access_token),
      error_callback: () => reject(new Error('Google sign-in was cancelled or the popup was blocked.')),
    });
    client.requestAccessToken({ prompt: '' });
  });
}

function selectFile(config, token) {
  return new Promise((resolve) => {
    const picker = window.google.picker;
    const view = new picker.DocsView(picker.ViewId.DOCS)
      .setMode(picker.DocsViewMode.LIST)
      .setMimeTypes(pickerMimeTypes);
    new picker.PickerBuilder()
      .setAppId(config.appId)
      .setDeveloperKey(config.apiKey)
      .setOAuthToken(token)
      .setOrigin(window.location.origin)
      .addView(view)
      .setCallback((result) => {
        if (result.action === picker.Action.PICKED) resolve(result.docs?.[0] || null);
        if (result.action === picker.Action.CANCEL) resolve(null);
      })
      .build()
      .setVisible(true);
  });
}

async function pickDocument(config, maxFileMb) {
  const token = await getToken(config);
  const file = await selectFile(config, token);
  if (!file) return null;
  const limit = maxFileMb * 1024 * 1024;
  if (file.sizeBytes && file.sizeBytes > limit) throw new Error('Choose a file up to ' + maxFileMb + ' MB.');
  const native = googleNativeTypes.includes(file.mimeType);
  const url =
    'https://www.googleapis.com/drive/v3/files/' +
    encodeURIComponent(file.id) +
    (native ? '/export?mimeType=application%2Fpdf' : '?alt=media');
  const headers = { Authorization: 'Bearer ' + token };
  if (file.resourceKey) headers['X-Goog-Drive-Resource-Keys'] = file.id + '/' + file.resourceKey;
  const response = await fetch(url, { headers, signal: AbortSignal.timeout?.(60000), redirect: 'error' });
  if (!response.ok) throw new Error('Google Drive could not download the selected file.');
  if (Number(response.headers.get('content-length')) > limit)
    throw new Error('Choose a file up to ' + maxFileMb + ' MB.');

  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > limit) {
      await reader.cancel();
      throw new Error('Choose a file up to ' + maxFileMb + ' MB.');
    }
    chunks.push(value);
  }
  return new File(chunks, native ? file.name + '.pdf' : file.name, {
    type: native ? 'application/pdf' : file.mimeType,
  });
}

/* Fixed bridge to the native CodaClauda shell. There is no generic shell or
 * filesystem command: every call is one named Tauri command. Outside the
 * desktop app (browser preview) a local mock backend is loaded instead. */

const tauri = () => window.__TAURI__?.core;
let mockBackend = null;

export const isNative = () => Boolean(tauri());

async function backend() {
  if (tauri()) return tauri();
  if (!mockBackend) mockBackend = (await import('../dev/mock.js')).createMock();
  return mockBackend;
}

export async function invoke(command, args = {}) {
  const api = await backend();
  const result = await api.invoke(command, args);
  if (!result || result.ok !== true) {
    const error = new Error(result?.error?.message || 'The local operation failed.');
    error.code = result?.error?.code || 'UNKNOWN_ERROR';
    throw error;
  }
  return result.data;
}

/** Coordination board operation through the bundled CLI (JSON in, JSON out). */
export const rpc = (op, args = {}) => invoke('rpc', { op, args });

/** Desktop-only helpers implemented in src-tauri/src/desktop.rs. */
export const desktop = {
  paths: () => invoke('desktop_paths'),
  loadState: () => invoke('desktop_state_load'),
  saveState: state => invoke('desktop_state_save', { state }),
  loadManifest: () => invoke('desktop_manifest_load'),
  scanProject: path => invoke('project_scan', { path }),
  discoverDesktop: () => invoke('desktop_discover_projects'),
  githubUser: () => invoke('github_user'),
  githubRepos: user => invoke('github_repos', { user }),
  /** Repos the signed-in gh account reaches as a collaborator / org member (never its own) → { user, repos, truncated }. */
  githubCollabRepos: () => invoke('github_collab_repos'),
  /** Creates a repo (with a README) in the GitHub CLI's signed-in account and clones it into parentDir\name → { path, full_name, url }. */
  createRepo: ({ name, description = '', private: isPrivate = true, parentDir }) => invoke('github_create_repo', { name, description, private: isPrivate, parentDir }),
  /** Clones owner/name into parentDir\name with the GitHub CLI → { path, full_name, url }. */
  cloneRepo: ({ fullName, parentDir }) => invoke('github_clone_repo', { fullName, parentDir }),
  saveAttachment: (name, dataBase64) => invoke('attachment_save', { name, dataBase64 }),
  startDictation: () => invoke('dictation_start'),
  attention: () => invoke('window_attention'),
  /** Opens an http(s) URL in the default browser or an existing folder in Explorer. */
  openExternal: target => invoke('open_external', { target }),
  pickFolder: () => invoke('pick_workspace'),
  preferences: () => invoke('preferences'),
  /** Native updater: op is check | status | authorize | poll | download | install (no other args). */
  update: op => invoke('update', { op, args: {} }),
};

// Publishing to GitHub from the browser: one commit containing the two images
// and the updated data/artworks.json, made with the GitHub REST API.

import { validateArtworks } from './data.js';

const API = 'https://api.github.com';
const DATA_PATH = 'data/artworks.json';

export class GitHubError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/** Guess "owner/repo" from a GitHub Pages address such as https://owner.github.io/repo/. */
export function guessRepository(location) {
  const match = /^([a-z0-9-]+)\.github\.io$/i.exec(location.hostname);
  if (!match) return '';
  const first = location.pathname.split('/').filter(Boolean)[0];
  if (!first || first.endsWith('.html')) return `${match[1]}/${match[1]}.github.io`;
  return `${match[1]}/${first}`;
}

export function slugify(text) {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Same layout as the existing file: 2-space indent and a final newline. */
export function formatArtworks(artworks) {
  return `${JSON.stringify(artworks, null, 2)}\n`;
}

function base64FromBytes(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function textFromBase64(base64) {
  const binary = atob(base64.replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(binary, c => c.charCodeAt(0)));
}

export class GitHub {
  constructor({ token, repository, branch = 'main', fetch = globalThis.fetch.bind(globalThis) }) {
    this.token = token;
    this.repository = repository;
    this.branch = branch;
    this.fetch = fetch;
  }

  async request(method, path, body) {
    const response = await this.fetch(`${API}/repos/${this.repository}${path}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
    const data = response.status === 204 ? null : await response.json().catch(() => null);
    if (!response.ok) {
      throw new GitHubError(explain(response.status, data?.message, this), response.status);
    }
    return data;
  }

  /** Check the token can reach the repository and branch. Returns the repository's details. */
  async check() {
    const repo = await this.request('GET', '');
    if (repo.permissions && !repo.permissions.push) {
      throw new GitHubError(`This token can read ${this.repository} but not change it.`, 403);
    }
    await this.request('GET', `/branches/${encodeURIComponent(this.branch)}`);
    return repo;
  }

  async readArtworks(commitSha) {
    const file = await this.request('GET', `/contents/${DATA_PATH}?ref=${commitSha}`);
    const text = file.content
      ? textFromBase64(file.content)
      : textFromBase64((await this.request('GET', `/git/blobs/${file.sha}`)).content);
    return JSON.parse(text);
  }

  async listArtworks() {
    const ref = await this.request('GET', `/git/ref/heads/${encodeURIComponent(this.branch)}`);
    return this.readArtworks(ref.object.sha);
  }

  /**
   * Add (or with `replace`, update) an artwork in a single commit.
   * `images` is a list of { path, bytes }. Reports progress through `onProgress(text)`.
   * Returns { commit, url }.
   */
  async publish({ entry, images, message, replace = false, onProgress = () => {} }) {
    onProgress('Uploading images…');
    const imageBlobs = [];
    for (const { path, bytes } of images) {
      const blob = await this.request('POST', '/git/blobs', { content: base64FromBytes(bytes), encoding: 'base64' });
      imageBlobs.push({ path, mode: '100644', type: 'blob', sha: blob.sha });
    }

    // If someone else changes the branch while we work (for example an upload
    // on github.com), start again from the new latest commit.
    for (let attempt = 1; ; attempt++) {
      onProgress('Updating the gallery list…');
      const ref = await this.request('GET', `/git/ref/heads/${encodeURIComponent(this.branch)}`);
      const parentSha = ref.object.sha;
      const parent = await this.request('GET', `/git/commits/${parentSha}`);
      const artworks = await this.readArtworks(parentSha);
      if (!Array.isArray(artworks)) throw new GitHubError(`${DATA_PATH} is not a list.`);

      const index = artworks.findIndex(artwork => artwork.id === entry.id);
      if (index >= 0 && !replace) {
        throw new GitHubError(`A painting with the id “${entry.id}” already exists. Choose a different title or id.`, 409);
      }
      const updated = [...artworks];
      if (index >= 0) updated[index] = entry;
      else updated.unshift(entry);
      validateArtworks(updated); // Same checks the gallery runs; throws if anything is off.

      onProgress('Saving…');
      const tree = await this.request('POST', '/git/trees', {
        base_tree: parent.tree.sha,
        tree: [...imageBlobs, { path: DATA_PATH, mode: '100644', type: 'blob', content: formatArtworks(updated) }],
      });
      const commit = await this.request('POST', '/git/commits', {
        message, tree: tree.sha, parents: [parentSha],
      });
      try {
        await this.request('PATCH', `/git/refs/heads/${encodeURIComponent(this.branch)}`, { sha: commit.sha, force: false });
        return { commit: commit.sha, url: commit.html_url ?? `https://github.com/${this.repository}/commit/${commit.sha}` };
      } catch (error) {
        if (error.status !== 422 || attempt >= 3) throw error;
      }
    }
  }
}

function explain(status, message = '', { repository, branch }) {
  if (status === 401) return 'GitHub did not accept the access token. It may have expired; create a new one in Settings.';
  if (status === 403 && /rate limit/i.test(message)) return 'GitHub is limiting requests right now. Try again in a few minutes.';
  if (status === 403) return `The access token isn’t allowed to change ${repository}. Give it “Contents: Read and write” permission for this repository.`;
  if (status === 404) return `Couldn’t find ${repository} (branch “${branch}”). Check Settings, and that the token has access to this repository.`;
  return `GitHub error ${status}${message ? `: ${message}` : ''}`;
}

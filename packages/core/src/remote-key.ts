// Internal to git.ts (not exported from the package): which repository a remote address names.
import fs from 'node:fs';
import path from 'node:path';

type PathApi = typeof path.posix;

export type KeyOptions = {
  /** Path rules to apply (default: this platform's). Tests pass `path.win32` or `path.posix`. */
  pathApi?: PathApi;
  /** Where git would find a local repository given as an absolute path (default: on disk, as git looks). */
  locate?: (abs: string) => string;
};

/**
 * Where git finds a local repository given as `abs`: the path itself, or else `abs.git`, with symlinks
 * resolved and a trailing `/.git` folded into its working tree. A path that does not exist is kept as written.
 */
export function locateLocal(abs: string): string {
  for (const candidate of [abs, `${abs}.git`]) {
    try {
      const real = fs.realpathSync(candidate);
      return path.basename(real) === '.git' ? path.dirname(real) : real;
    } catch {
      // try the next spelling
    }
  }
  return abs;
}

/**
 * The repository an address names, for the seen record (R25). Never the raw string:
 * - **Network** (`https://`, `ssh://`, `git://`, scp-like `user@host:path`): the host in lower case, without
 *   user info or port, and the path without repeated or trailing slashes or a `.git` suffix. So a rotated
 *   token, another user name, host case, and the https and ssh forms of one host and path are one repository.
 *   Ports and user names are deliberately left out (two servers on one host on different ports, or two
 *   users' home-relative paths on one ssh server, share a record).
 * - **Local** (a path, absolute or relative, or a `file://` URL with an empty or `localhost` host): the
 *   directory git would use. A relative path is resolved against the checkout `base`, as git does. The
 *   `.git` suffix is kept: `data.git` and `data` are two directories (unless only `data.git` exists, which
 *   is where git goes for `data`). On Windows a drive path in either slash style and its `file:///C:/…`
 *   URL, and a UNC path and its `file://server/share/…` URL, are one repository, compared without case.
 */
export function repositoryKey(address: string, base: string, o: KeyOptions = {}): string {
  const pa = o.pathApi ?? path;
  const windows = pa === path.win32;
  const locate = o.locate ?? (pa === path ? locateLocal : (p: string) => p);
  const a = address.trim();

  const local = (p: string): string => {
    let r = locate(pa.resolve(base, p));
    const trimmed = windows ? r.replace(/[\\/]+$/, '') : r.replace(/\/+$/, '');
    if (trimmed && !(windows && /^[a-z]:$/i.test(trimmed))) r = trimmed;
    if (windows) r = r.replace(/\//g, '\\').toLowerCase();
    return `local\n${r}`;
  };
  const network = (host: string, p: string): string => {
    let q = p.replace(/\/{2,}/g, '/').replace(/\/+$/, '').replace(/\.git$/, '').replace(/\/+$/, '');
    if (!q.startsWith('/')) q = `/${q}`;
    return `net\n${host.toLowerCase()}\n${q}`;
  };

  const url = /^([a-z][a-z0-9+.-]+):\/\/([^/]*)(.*)$/i.exec(a);
  if (url) {
    const authority = url[2]!;
    const host = authority.slice(authority.lastIndexOf('@') + 1).replace(/:\d*$/, '');
    let p = url[3] || '/';
    if (url[1]!.toLowerCase() !== 'file') return network(host, p);
    try {
      p = decodeURIComponent(p);
    } catch {
      // keep it as written
    }
    if (host === '' || host.toLowerCase() === 'localhost') {
      if (windows && /^\/[a-z]:/i.test(p)) p = p.slice(1);
      return local(p);
    }
    return windows ? local(`\\\\${host}${p.replace(/\//g, '\\')}`) : network(host, p);
  }
  const scp = /^(?:[^@/\\]+@)?([^:/\\]{2,}):(?!\/\/)(.*)$/.exec(a);
  if (scp) return network(scp[1]!, scp[2]!);
  return local(a);
}

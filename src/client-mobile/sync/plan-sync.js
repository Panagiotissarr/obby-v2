/**
 * plan-sync.js — pure decision function for BIDIRECTIONAL sync (the
 * serverless-sync brief §3ב). Runs once per "Sync now" over the union of
 * remote-manifest paths and local-manifest paths, given:
 *
 *   remoteEntries — [{path, size, hash}] from RemoteClient.manifestAll()
 *   localHashes   — {[path]: {hash, size}} from local-manifest.js (L)
 *   syncedHashes  — {[path]: hash} from hashStore.all() (S — last-synced)
 *
 * No I/O here — network/OPFS/IndexedDB all live in run-sync.js and the
 * sibling adapters. Exercised directly by node:test, no browser needed.
 *
 * The decision table, per path (⊥ = absent):
 *
 *   L⊥    R⊥    → both gone: forget S if we had one.
 *   L⊥    R=…   → S⊥: download (new on server)
 *                 S=R: we deleted it, server unchanged → push deletion
 *                 else: we deleted it, server edited → conflict (server wins:
 *                       nothing of ours to keep, the deletion is abandoned)
 *   L=…   R⊥    → S⊥: push (new local file)
 *                 S=L: server deleted it, we never touched it → conform
 *                      (delete locally, forget S)
 *                 else: we edited it, server deleted it → conflict (copy our
 *                       content to a .conflict- file, conform to server)
 *   L=R   → fully equal: S=L → nothing; else set S:=L (first sync of an
 *            identical file, or both sides landed the same content — this
 *            keeps S from going stale and misreading a later edit as
 *            "never synced")
 *   L≠R   → S=L: server moved, local untouched → download (pull row 4)
 *           S=R: local moved, server untouched → push change (pull row 5,
 *                the branch that used to be "skip — push is v2")
 *           else (both moved, or S⊥ never synced): conflict — copy local
 *                content to a .conflict- file, then conform the original
 *                path to the server. S⊥+different deliberately does NOT
 *                attempt a push: the server would reject it anyway
 *                (base mismatch), so uploading would waste the bytes.
 *
 * "Server wins at the original path, local content survives as a conflict
 * copy" (brief §4) — conflicts[] reports the SERVER's state for the path,
 * the same shape the commit endpoint's CAS conflicts use, so run-sync.js
 * resolves both sources with one code path.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.__owSyncPlanSync = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function planSync(remoteEntries, localHashes, syncedHashes) {
    var local = localHashes || {};
    var synced = syncedHashes || {};
    var remote = {};
    var i;

    for (i = 0; i < remoteEntries.length; i++) {
      remote[remoteEntries[i].path] = remoteEntries[i];
    }

    var plan = {
      downloads: [],
      pushChanges: [],
      pushDeletions: [],
      conflicts: [],
      setSynced: [],
      forgetSynced: [],
      localDeletes: [],
      inSync: 0,
    };

    // Union of all three sides' paths: remote, local, and synced-only (a path
    // present only in S means it vanished from both sides — it must be
    // forgotten, which can only happen if it enters the union here).
    var paths = [];
    var seen = {};
    function addPath(p) {
      if (Object.prototype.hasOwnProperty.call(seen, p)) return;
      seen[p] = true;
      paths.push(p);
    }
    for (i = 0; i < remoteEntries.length; i++) addPath(remoteEntries[i].path);
    var localPaths = Object.keys(local);
    for (i = 0; i < localPaths.length; i++) addPath(localPaths[i]);
    var syncedPaths = Object.keys(synced);
    for (i = 0; i < syncedPaths.length; i++) addPath(syncedPaths[i]);

    for (i = 0; i < paths.length; i++) {
      var path = paths[i];
      var lEntry = Object.prototype.hasOwnProperty.call(local, path) ? local[path] : undefined;
      var rEntry = Object.prototype.hasOwnProperty.call(remote, path) ? remote[path] : undefined;
      var L = lEntry ? lEntry.hash : undefined;
      var R = rEntry ? rEntry.hash : undefined;
      var S = Object.prototype.hasOwnProperty.call(synced, path) ? synced[path] : undefined;

      if (L === undefined && R === undefined) {
        // both sides gone
        if (S !== undefined) plan.forgetSynced.push(path);
        else plan.inSync++;
      } else if (L === undefined) {
        // server-only
        if (S === undefined) {
          plan.downloads.push({ path: path, hash: R, size: rEntry.size });
        } else if (S === R) {
          plan.pushDeletions.push({ path: path, baseHash: S });
        } else {
          plan.conflicts.push({ path: path, hash: R, size: rEntry.size, deleted: false });
        }
      } else if (R === undefined) {
        // local-only
        if (S === undefined) {
          plan.pushChanges.push({ path: path, hash: L, size: lEntry.size, baseHash: null });
        } else if (S === L) {
          plan.localDeletes.push(path);
        } else {
          plan.conflicts.push({ path: path, hash: null, size: 0, deleted: true });
        }
      } else if (L === R) {
        if (S === L) plan.inSync++;
        else plan.setSynced.push({ path: path, hash: L });
      } else if (S === L) {
        plan.downloads.push({ path: path, hash: R, size: rEntry.size });
      } else if (S === R) {
        plan.pushChanges.push({ path: path, hash: L, size: lEntry.size, baseHash: S });
      } else {
        plan.conflicts.push({ path: path, hash: R, size: rEntry.size, deleted: false });
      }
    }

    return plan;
  }

  return { planSync: planSync };
});

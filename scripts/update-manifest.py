#!/usr/bin/env python3
"""Upsert a version entry in the Jellyfin plugin catalogue manifest.

Manifest format follows https://jellyfin.org/docs/general/server/plugins/index
(checksum is the MD5 hex of the release zip).
"""

import argparse
import datetime
import hashlib
import json
import sys


def md5_of(path):
    h = hashlib.md5()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--version", required=True)
    ap.add_argument("--zip", required=True)
    ap.add_argument("--url", required=True)
    ap.add_argument("--target-abi", required=True)
    ap.add_argument("--changelog", default="")
    args = ap.parse_args()

    with open(args.manifest) as f:
        catalog = json.load(f)

    plugins = catalog if isinstance(catalog, list) else [catalog]
    if len(plugins) != 1:
        print("expected exactly one plugin in manifest", file=sys.stderr)
        return 1
    plugin = plugins[0]

    entry = {
        "version": args.version,
        "changelog": args.changelog,
        "targetAbi": args.target_abi,
        "sourceUrl": args.url,
        "checksum": md5_of(args.zip),
        "timestamp": datetime.datetime.now(datetime.timezone.utc).strftime(
            "%Y-%m-%dT%H:%M:%SZ"),
    }
    versions = [v for v in plugin.get("versions", [])
                if v.get("version") != args.version]
    versions.append(entry)
    plugin["versions"] = versions

    with open(args.manifest, "w") as f:
        json.dump(catalog, f, indent=2)
        f.write("\n")
    print(f"upserted {args.version} ({entry['checksum']})")


if __name__ == "__main__":
    main()

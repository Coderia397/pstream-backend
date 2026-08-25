# pstream-backend — archived

This was the JavaScript backend for [pstream.watch](https://pstream.watch).
It has been replaced by Rust and is no longer maintained or deployed.

## Where the code went

| | |
|---|---|
| **[pstream-resolver-rs](https://github.com/Coderia397/pstream-resolver-rs)** | The phone resolver — **this is what runs in production.** One static aarch64 binary. Also holds `pstream-shared`, which carries the 13 provider extractors, the streaming proxy and the m3u8 rewriter. |
| **[pstream-backend-rs](https://github.com/Coderia397/pstream-backend-rs)** | Port of the giga backend. See its `PORTING.md` first — most of those routes have no caller. |

## The original code

Tagged **[`js-final`](../../tree/js-final)**. Nothing is lost; check it out to
read the implementation any extractor was ported from.

```sh
git checkout js-final
```

## Why it was replaced

The resolver runs on a phone. The JS version needed a Node runtime and pulled
**506 npm packages** to use four of them — one of which, `yt-dlp-exec`, ran a
python version check in its install hook that fails under Termux. Seven more
were declared and never imported at all, including the whole puppeteer trio,
whose install hook downloads Chromium.

The Rust build is a **3.4 MB static binary** with nothing to install on the
device, published by CI and pulled down by a checksum-comparing updater.

It is also measurably faster: on identical resolves the Rust version returned
the same provider, the same playlist and the same subtitle set about **30%
quicker**.

## Things found while porting

Recorded because they were live in this code, and anyone reading `js-final`
should know:

- **`moviebox.js` / `nontongo.js` return `{success: false}` on failure.** That
  object is truthy, so it survives `.filter(Boolean)` and counts as a working
  provider — a resolve could report success with zero playable sources.

- **`/proxy/subtitle`'s host allowlist uses `host.endsWith(d)`.** That also
  matches `evilgooglevideo.com`. Anyone registering a lookalike could use the
  endpoint as an open proxy, from a server the providers trust.

- **`/api/media-probe` fetched any URL with no restriction** — including
  loopback and LAN addresses, from a process listening on the same host.

- **`/api/media-probe` was never served in production.** The frontend has
  called it since `utils/mediaProbe.ts` was written; neither this backend nor
  the phone ever exposed it, so it returned 404 the whole time.

- **The giga backend was never deployed anywhere.** `DEPLOY.md` said "designed
  for Hugging Face Spaces", which is not the same as running there. The
  frontend's only backend URL pointed at the phone, and Supabase was called
  straight from the browser — so `index.js` and its 37 routes had no caller.

All four defects are fixed in the Rust port, with tests covering the lookalike
hosts and the local-address cases.

## License

MIT — see [LICENSE](LICENSE).

# Streaming Providers — Embed API & Integration Reference

> **Documentation & URL Patterns for Embedded Players and Video APIs**

---

## 1. VidSrc (`vidsrc.me` / `vidsrc.to` / `vidsrc.in`)

- **Official Status Page:** [vidsrc.domains](https://vidsrc.domains/)
- **Movie Embed Pattern:**
  ```http
  GET https://vidsrc.me/embed/movie/{tmdbId}
  GET https://vidsrc.in/embed/movie/{tmdbId}
  GET https://vidsrc.to/embed/movie/{tmdbId}
  ```
- **TV Series Embed Pattern:**
  ```http
  GET https://vidsrc.me/embed/tv/{tmdbId}/{season}/{episode}
  GET https://vidsrc.in/embed/tv/{tmdbId}/{season}/{episode}
  GET https://vidsrc.to/embed/tv/{tmdbId}/{season}/{episode}
  ```

---

## 2. AutoEmbed (`autoembed.app`)

- **Official Website:** [autoembed.app](https://autoembed.app/)
- **Telegram Updates:** [t.me/auto_embed](https://t.me/auto_embed)
- **Movie Embed Pattern:**
  ```http
  GET https://player.autoembed.co/embed/movie/{tmdbId}
  ```
- **TV Series Embed Pattern:**
  ```http
  GET https://player.autoembed.co/embed/tv/{tmdbId}/{season}/{episode}
  ```

---

## 3. 2Embed (`2embed.cc` / `2embed.skin`)

- **Official Website:** [2embed.cc](https://www.2embed.cc/)
- **Movie Embed Pattern:**
  ```http
  GET https://www.2embed.cc/embed/{tmdbId}
  GET https://2embed.skin/embed/{tmdbId}
  ```
- **TV Series Embed Pattern:**
  ```http
  GET https://www.2embed.cc/embedtv/{tmdbId}&s={season}&e={episode}
  ```

---

## 4. VidLink (`vidlink.pro`)

- **Official Website:** [vidlink.pro](https://vidlink.pro/)
- **Movie Embed Pattern:**
  ```http
  GET https://vidlink.pro/movie/{tmdbId}
  ```
- **TV Series Embed Pattern:**
  ```http
  GET https://vidlink.pro/tv/{tmdbId}/{season}/{episode}
  ```

---

## 5. SuperEmbed (`superembed.stream`)

- **Official Website:** [superembed.stream](https://www.superembed.stream/)
- **Movie Embed Pattern:**
  ```http
  GET https://multiembed.mov/directstream.php?video_id={tmdbId}&tmdb=1
  ```
- **TV Series Embed Pattern:**
  ```http
  GET https://multiembed.mov/directstream.php?video_id={tmdbId}&tmdb=1&s={season}&e={episode}
  ```

---

## 6. SmashyStream (`smashystream.com`)

- **Official Website:** [embed.smashystream.com](https://embed.smashystream.com/)
- **Movie Embed Pattern:**
  ```http
  GET https://embed.smashystream.com/play3.php?tmdb={tmdbId}
  ```

---

## 7. VidFast (`vidfast.pro`)

- **Official Community:** [Discord Invite](https://discord.com/invite/hZ5HY4wh7B)
- **Movie Embed Pattern:**
  ```http
  GET https://vidfast.pro/movie/{tmdbId}
  ```
- **TV Series Embed Pattern:**
  ```http
  GET https://vidfast.pro/tv/{tmdbId}/{season}/{episode}
  ```

---

## 8. WatchFreeStreams (`wfs.lol`)

- **Official API Documentation:** [wfs.lol/embed-api](https://wfs.lol/embed-api)
- **Movie Embed Pattern:**
  ```http
  GET https://wfs.lol/embed-api/movie/{tmdbId}
  ```

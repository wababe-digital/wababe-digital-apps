const GITHUB_REPO =
  "https://github.com/wababe-digital/wababe-digital-apps";

const GITHUB_API =
  "https://api.github.com/repos/wababe-digital/wababe-digital-apps/releases?per_page=100";

const GITHUB_API_VERSION = "2026-03-10";

let cachedInstallationToken = null;
let cachedInstallationTokenExpiresAt = 0;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    /*
     * ============================================================
     * GITHUB RELEASES API
     * ============================================================
     */

    if (url.pathname === "/api/releases") {
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: corsHeaders()
        });
      }

      if (request.method !== "GET") {
        return new Response("Method Not Allowed", {
          status: 405,
          headers: {
            "Allow": "GET, OPTIONS",
            ...corsHeaders()
          }
        });
      }

      try {
        const installationToken =
          await getInstallationToken(env);

        const response = await fetch(GITHUB_API, {
          method: "GET",
          headers: {
            "Accept":
              "application/vnd.github+json",

            "Authorization":
              "Bearer " + installationToken,

            "X-GitHub-Api-Version":
              GITHUB_API_VERSION,

            "User-Agent":
              "Wababe-Digital-Apps"
          }
        });

        if (!response.ok) {
          const errorBody = await response.text();
          return new Response(errorBody, {
            status: response.status,
            headers: {
              "Content-Type": "application/json; charset=utf-8",
              "Cache-Control": "no-store",
              ...corsHeaders()
            }
          });
        }

        const publicReleases = await response.json();
        const privateReleases = latestPrivateApps(await fetchPrivateReleases(installationToken));
        const safePrivateReleases = privateReleases.map(function (release) {
          return {
            id: "private-" + privateAppKey(release),
            private: true,
            privateAppId: privateAppKey(release),
            name: release.name || release.tag_name || "Private App",
            tag_name: release.tag_name || "Latest",
            body: release.body || "Private Android application from Wababe Digital Apps.",
            draft: !!release.draft,
            prerelease: !!release.prerelease,
            assets: (release.assets || []).map(function (asset) {
              return {
                id: asset.id,
                name: asset.name,
                size: asset.size,
                download_count: asset.download_count || 0
              };
            })
          };
        });

        return new Response(JSON.stringify(
          (Array.isArray(publicReleases) ? publicReleases : []).concat(safePrivateReleases)
        ), {
          status: 200,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "public, max-age=120",
            ...corsHeaders()
          }
        });

      } catch (error) {

        console.error(
          "GitHub App authentication error:",
          error
        );

        return new Response(
          JSON.stringify({
            error:
              "Unable to authenticate with GitHub App.",

            detail:
              error && error.message
                ? error.message
                : "Unknown error"
          }),
          {
            status: 500,
            headers: {
              "Content-Type":
                "application/json; charset=utf-8",

              ...corsHeaders()
            }
          }
        );
      }
    }


    /* PRIVATE APP ADMIN LOGIN */
    if (url.pathname === "/api/admin/login" && request.method === "POST") {
      try {
        const body = await request.json();
        if (!env.ADMIN_PASSWORD || !env.ADMIN_SESSION_SECRET) {
          return jsonResponse({ error: "Admin security secrets are not configured." }, 503);
        }
        const ip = request.headers.get("CF-Connecting-IP") || "unknown";
        const loginKey = "admin-attempt:" + ip;
        const attempts = Number(await env.APP_SECURITY.get(loginKey) || 0);
        if (attempts >= 8) return jsonResponse({ error: "Too many login attempts. Try again in 10 minutes." }, 429);
        if (!constantTimeEqual(String(body.password || ""), env.ADMIN_PASSWORD)) {
          await env.APP_SECURITY.put(loginKey, String(attempts + 1), { expirationTtl: 600 });
          return jsonResponse({ error: "Incorrect admin password." }, 401);
        }
        await env.APP_SECURITY.delete(loginKey);
        const token = await createAdminToken(env.ADMIN_SESSION_SECRET);
        return jsonResponse({ token, expiresIn: 21600 });
      } catch (error) {
        return jsonResponse({ error: "Invalid login request." }, 400);
      }
    }

    /* PRIVATE APP ADMIN LIST */
    if (url.pathname === "/api/admin/apps" && request.method === "GET") {
      if (!(await isAdminRequest(request, env))) return jsonResponse({ error: "Unauthorized." }, 401);
      try {
        const token = await getInstallationToken(env);
        const releases = latestPrivateApps(await fetchPrivateReleases(token));
        const apps = [];
        for (const release of releases) {
          const appKey = privateAppKey(release);
          const apk = (release.assets || []).find(a => String(a.name || "").toLowerCase().endsWith(".apk"));
          if (!apk) continue;
          const stored = await env.APP_SECURITY.get("code:" + appKey);
          apps.push({ id: appKey, name: release.name || release.tag_name || "Private App", version: release.tag_name || "Latest", apkName: apk.name, protected: !!stored });
        }
        return jsonResponse({ apps });
      } catch (error) {
        return jsonResponse({ error: "Unable to load private apps." }, 500);
      }
    }

    /* SET OR REMOVE A PRIVATE APP CODE */
    if (url.pathname === "/api/admin/security" && request.method === "POST") {
      if (!(await isAdminRequest(request, env))) return jsonResponse({ error: "Unauthorized." }, 401);
      try {
        const body = await request.json();
        const appId = String(body.appId || "");
        const code = String(body.code || "");
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(appId)) return jsonResponse({ error: "Invalid app selection." }, 400);
        if (!code) {
          await env.APP_SECURITY.delete("code:" + appId);
          return jsonResponse({ ok: true, message: "Code removed. This app remains locked until a new code is set." });
        }
        if (code.length < 4 || code.length > 128) return jsonResponse({ error: "Code must contain 4 to 128 characters." }, 400);
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const hash = await hashCode(code, salt);
        await env.APP_SECURITY.put("code:" + appId, JSON.stringify({ salt: bytesToHex(salt), hash, iterations: 120000 }));
        return jsonResponse({ ok: true, message: "Private app code saved." });
      } catch (error) {
        return jsonResponse({ error: "Unable to save app security." }, 500);
      }
    }

    /* CHECK CODE AND ISSUE A ONE-TIME DOWNLOAD TICKET */
    if (url.pathname === "/api/private-download-ticket" && request.method === "POST") {
      try {
        const body = await request.json();
        const appId = String(body.appId || "");
        const code = String(body.code || "");
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(appId) || !code) return jsonResponse({ error: "App and security code are required." }, 400);
        const ip = request.headers.get("CF-Connecting-IP") || "unknown";
        const rateKey = "attempt:" + appId + ":" + ip;
        const attempts = Number(await env.APP_SECURITY.get(rateKey) || 0);
        if (attempts >= 8) return jsonResponse({ error: "Too many attempts. Try again later." }, 429);
        const saved = await env.APP_SECURITY.get("code:" + appId);
        if (!saved) return jsonResponse({ error: "This app is not protected or its code is unavailable." }, 403);
        const record = JSON.parse(saved);
        const salt = hexToBytes(record.salt);
        const candidate = await hashCode(code, salt, record.iterations || 120000);
        if (!constantTimeEqual(candidate, record.hash)) {
          await env.APP_SECURITY.put(rateKey, String(attempts + 1), { expirationTtl: 600 });
          return jsonResponse({ error: "Incorrect security code." }, 403);
        }
        await env.APP_SECURITY.delete(rateKey);
        const ghToken = await getInstallationToken(env);
        const releases = latestPrivateApps(await fetchPrivateReleases(ghToken));
        const release = releases.find(r => privateAppKey(r) === appId);
        const apk = release && (release.assets || []).find(a => String(a.name || "").toLowerCase().endsWith(".apk"));
        if (!apk) return jsonResponse({ error: "APK not found for this app." }, 404);
        const ticket = randomHex(24);
        await env.APP_SECURITY.put("ticket:" + ticket, JSON.stringify({ assetId: apk.id, filename: apk.name }), { expirationTtl: 90 });
        return jsonResponse({ url: "/download/private?ticket=" + ticket });
      } catch (error) {
        return jsonResponse({ error: "Unable to authorize this download." }, 500);
      }
    }

    /* STREAM PRIVATE APK AFTER ONE-TIME TICKET VALIDATION */
    if (url.pathname === "/download/private" && request.method === "GET") {
      const ticket = url.searchParams.get("ticket") || "";
      if (!/^[a-f0-9]{48}$/.test(ticket)) return new Response("Invalid download ticket.", { status: 403 });
      const key = "ticket:" + ticket;
      const saved = await env.APP_SECURITY.get(key);
      if (!saved) return new Response("Download ticket expired or already used.", { status: 403 });
      await env.APP_SECURITY.delete(key);
      try {
        const data = JSON.parse(saved);
        const ghToken = await getInstallationToken(env);
        const assetResponse = await fetch("https://api.github.com/repos/wababe-digital/wababe-private-apps/releases/assets/" + encodeURIComponent(data.assetId), {
          headers: {
            "Accept": "application/octet-stream",
            "Authorization": "Bearer " + ghToken,
            "X-GitHub-Api-Version": GITHUB_API_VERSION,
            "User-Agent": "Wababe-Digital-Apps"
          },
          redirect: "follow"
        });
        if (!assetResponse.ok || !assetResponse.body) return new Response("Unable to retrieve private APK.", { status: 502 });
        const headers = new Headers({
          "Content-Type": "application/vnd.android.package-archive",
          "Content-Disposition": "attachment; filename=\"" + safeFilename(data.filename) + "\"",
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff"
        });
        const length = assetResponse.headers.get("Content-Length");
        if (length) headers.set("Content-Length", length);
        return new Response(assetResponse.body, { status: 200, headers });
      } catch (error) {
        return new Response("Private download service error.", { status: 500 });
      }
    }

    /*
     * ============================================================
     * APK DOWNLOAD
     * ============================================================
     */

    if (url.pathname === "/download") {

      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: corsHeaders()
        });
      }

      if (request.method !== "GET") {
        return new Response(
          "Method Not Allowed",
          {
            status: 405,
            headers: {
              "Allow": "GET, OPTIONS",
              ...corsHeaders()
            }
          }
        );
      }

      const apkUrl =
        url.searchParams.get("url");

      if (!apkUrl) {
        return new Response(
          "APK URL is required.",
          {
            status: 400,
            headers: corsHeaders()
          }
        );
      }

      if (
        !apkUrl.startsWith(
          GITHUB_REPO +
          "/releases/download/"
        )
      ) {
        return new Response(
          "Invalid download source.",
          {
            status: 403,
            headers: corsHeaders()
          }
        );
      }

      try {

        const response = await fetch(
          apkUrl,
          {
            method: "GET",
            redirect: "follow"
          }
        );

        if (!response.ok) {
          return new Response(
            "Unable to download APK.",
            {
              status: response.status,
              headers: corsHeaders()
            }
          );
        }

        const headers =
          new Headers();

        headers.set(
          "Content-Type",
          "application/vnd.android.package-archive"
        );

        const publicFilename = safeFilename(
          decodeURIComponent(new URL(apkUrl).pathname.split("/").pop() || "Wababe-App.apk")
        );
        headers.set(
          "Content-Disposition",
          'attachment; filename="' + publicFilename + '"'
        );

        headers.set(
          "Cache-Control",
          "public, max-age=3600"
        );

        const contentLength =
          response.headers.get(
            "Content-Length"
          );

        if (contentLength) {
          headers.set(
            "Content-Length",
            contentLength
          );
        }

        const cors =
          corsHeaders();

        Object.entries(cors).forEach(
          function (entry) {
            headers.set(
              entry[0],
              entry[1]
            );
          }
        );

        return new Response(
          response.body,
          {
            status: 200,
            headers: headers
          }
        );

      } catch (error) {

        return new Response(
          "Download service error.",
          {
            status: 500,
            headers: {
              "Content-Type":
                "text/plain",

              ...corsHeaders()
            }
          }
        );
      }
    }


    /*
     * ============================================================
     * OPTIONS
     * ============================================================
     */

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders()
      });
    }


    /*
     * ============================================================
     * STATIC WEBSITE
     * ============================================================
     */

    return env.ASSETS.fetch(request);
  }
};



async function fetchPrivateReleases(token) {
  const response = await fetch("https://api.github.com/repos/wababe-digital/wababe-private-apps/releases?per_page=100", {
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": "Bearer " + token,
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
      "User-Agent": "Wababe-Digital-Apps"
    }
  });
  if (!response.ok) throw new Error("Private releases request failed: " + response.status);
  const data = await response.json();
  return Array.isArray(data) ? data : [];
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...corsHeaders() }
  });
}

function constantTimeEqual(a, b) {
  a = String(a); b = String(b);
  let diff = a.length ^ b.length;
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

async function createAdminToken(secret) {
  const payload = base64UrlEncode(JSON.stringify({ exp: Date.now() + 6 * 60 * 60 * 1000, role: "admin" }));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return payload + "." + arrayBufferToBase64Url(sig);
}

async function isAdminRequest(request, env) {
  if (!env.ADMIN_SESSION_SECRET) return false;
  const header = request.headers.get("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.ADMIN_SESSION_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(parts[0]));
  if (!constantTimeEqual(arrayBufferToBase64Url(sig), parts[1])) return false;
  try {
    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[0])));
    return payload.role === "admin" && payload.exp > Date.now();
  } catch (error) { return false; }
}

async function hashCode(code, salt, iterations = 120000) {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(code), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations, hash: "SHA-256" }, material, 256);
  return arrayBufferToBase64Url(bits);
}

function bytesToHex(bytes) { return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join(""); }
function hexToBytes(hex) { const out = new Uint8Array(hex.length / 2); for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16); return out; }
function randomHex(size) { return bytesToHex(crypto.getRandomValues(new Uint8Array(size))); }
function base64UrlDecode(value) { const normalized = value.replace(/-/g, "+").replace(/_/g, "/"); const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4)); return Uint8Array.from(binary, c => c.charCodeAt(0)); }
function safeFilename(name) { return String(name || "Wababe-App.apk").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120); }
function privateAppKey(release) {
  const base = String(release.name || release.tag_name || "private-app").toLowerCase()
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  return base || "private-app-" + String(release.id);
}

function latestPrivateApps(releases) {
  const seen = new Set();
  return releases.filter(function (release) {
    if (release.draft || release.prerelease) return false;
    if (!(release.assets || []).some(a => String(a.name || "").toLowerCase().endsWith(".apk"))) return false;
    const key = privateAppKey(release);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/*
 * ================================================================
 * GET GITHUB INSTALLATION TOKEN
 * ================================================================
 */

async function getInstallationToken(env) {

  const now =
    Date.now();

  /*
   * Reuse cached token while it still has
   * more than 5 minutes remaining.
   */

  if (
    cachedInstallationToken &&
    cachedInstallationTokenExpiresAt >
      now + 5 * 60 * 1000
  ) {
    return cachedInstallationToken;
  }


  if (!env.GITHUB_APP_ID) {
    throw new Error(
      "GITHUB_APP_ID secret is missing."
    );
  }

  if (!env.GITHUB_INSTALLATION_ID) {
    throw new Error(
      "GITHUB_INSTALLATION_ID secret is missing."
    );
  }

  if (!env.GITHUB_PRIVATE_KEY) {
    throw new Error(
      "GITHUB_PRIVATE_KEY secret is missing."
    );
  }


  /*
   * Create JWT for GitHub App.
   */

  const jwt =
    await createGitHubAppJWT(
      env.GITHUB_APP_ID,
      env.GITHUB_PRIVATE_KEY
    );


  /*
   * Ask GitHub for an installation token.
   */

  const tokenUrl =
    "https://api.github.com/app/installations/" +
    encodeURIComponent(
      env.GITHUB_INSTALLATION_ID
    ) +
    "/access_tokens";


  const response =
    await fetch(
      tokenUrl,
      {
        method: "POST",

        headers: {
          "Accept":
            "application/vnd.github+json",

          "Authorization":
            "Bearer " + jwt,

          "X-GitHub-Api-Version":
            GITHUB_API_VERSION,

          "User-Agent":
            "Wababe-Digital-Apps",

          "Content-Type":
            "application/json"
        },

        body: JSON.stringify({
          repositories: [
            "wababe-digital-apps",
            "wababe-private-apps"
          ]
        })
      }
    );


  if (!response.ok) {

    const errorText =
      await response.text();

    throw new Error(
      "GitHub installation token request failed. " +
      response.status +
      ": " +
      errorText
    );
  }


  const data =
    await response.json();


  if (!data.token) {
    throw new Error(
      "GitHub did not return an installation token."
    );
  }


  cachedInstallationToken =
    data.token;


  if (data.expires_at) {

    cachedInstallationTokenExpiresAt =
      new Date(
        data.expires_at
      ).getTime();

  } else {

    cachedInstallationTokenExpiresAt =
      now +
      55 * 60 * 1000;
  }


  return cachedInstallationToken;
}


/*
 * ================================================================
 * CREATE GITHUB APP JWT
 * ================================================================
 */

async function createGitHubAppJWT(
  appId,
  privatePem
) {

  const now =
    Math.floor(
      Date.now() / 1000
    );


  const header = {
    alg: "RS256",
    typ: "JWT"
  };


  const payload = {
    iat: now - 60,
    exp: now + 9 * 60,
    iss: appId
  };


  const encodedHeader =
    base64UrlEncode(
      JSON.stringify(header)
    );


  const encodedPayload =
    base64UrlEncode(
      JSON.stringify(payload)
    );


  const unsignedToken =
    encodedHeader +
    "." +
    encodedPayload;


  const privateKey =
    await importPrivateKey(
      privatePem
    );


  const data =
    new TextEncoder().encode(
      unsignedToken
    );


  const signature =
    await crypto.subtle.sign(
      {
        name:
          "RSASSA-PKCS1-v1_5"
      },
      privateKey,
      data
    );


  return (
    unsignedToken +
    "." +
    arrayBufferToBase64Url(
      signature
    )
  );
}


/*
 * ================================================================
 * IMPORT RSA PRIVATE KEY
 * Supports GitHub PEM formats:
 *
 * -----BEGIN RSA PRIVATE KEY-----
 * -----BEGIN PRIVATE KEY-----
 * ================================================================
 */

async function importPrivateKey(
  pem
) {

  const cleanPem =
    pem
      .replace(
        /-----BEGIN RSA PRIVATE KEY-----/g,
        ""
      )
      .replace(
        /-----END RSA PRIVATE KEY-----/g,
        ""
      )
      .replace(
        /-----BEGIN PRIVATE KEY-----/g,
        ""
      )
      .replace(
        /-----END PRIVATE KEY-----/g,
        ""
      )
      .replace(
        /\s/g,
        ""
      );


  const binary =
    atob(cleanPem);


  const pkcsData =
    new Uint8Array(
      binary.length
    );


  for (
    let i = 0;
    i < binary.length;
    i++
  ) {
    pkcsData[i] =
      binary.charCodeAt(i);
  }


  /*
   * GitHub commonly gives PKCS#1
   * RSA private keys.
   *
   * Convert PKCS#1 to PKCS#8
   * before Web Crypto import.
   */

  let keyData =
    pkcsData;


  if (
    pem.indexOf(
      "BEGIN RSA PRIVATE KEY"
    ) !== -1
  ) {

    keyData =
      convertPkcs1ToPkcs8(
        pkcsData
      );
  }


  return await crypto.subtle.importKey(
    "pkcs8",
    keyData.buffer,
    {
      name:
        "RSASSA-PKCS1-v1_5",
      hash:
        "SHA-256"
    },
    false,
    [
      "sign"
    ]
  );
}


/*
 * ================================================================
 * PKCS#1 → PKCS#8
 * ================================================================
 */

function convertPkcs1ToPkcs8(
  pkcs1
) {

  const rsaAlgorithmIdentifier =
    new Uint8Array([
      0x30,
      0x0d,

      0x06,
      0x09,

      0x2a,
      0x86,
      0x48,
      0x86,
      0xf7,
      0x0d,
      0x01,
      0x01,
      0x01,

      0x05,
      0x00
    ]);


  const octetString =
    derWrap(
      0x04,
      pkcs1
    );


  const inner =
    concatUint8Arrays(
      new Uint8Array([
        0x02,
        0x01,
        0x00
      ]),
      rsaAlgorithmIdentifier,
      octetString
    );


  return derWrap(
    0x30,
    inner
  );
}


/*
 * ================================================================
 * DER HELPERS
 * ================================================================
 */

function derWrap(
  tag,
  data
) {

  const length =
    derLength(
      data.length
    );


  return concatUint8Arrays(
    new Uint8Array([
      tag
    ]),
    length,
    data
  );
}


function derLength(
  length
) {

  if (length < 128) {

    return new Uint8Array([
      length
    ]);
  }


  const bytes = [];

  let value =
    length;


  while (
    value > 0
  ) {

    bytes.unshift(
      value & 255
    );

    value =
      Math.floor(
        value / 256
      );
  }


  return new Uint8Array([
    0x80 |
      bytes.length,
    ...bytes
  ]);
}


function concatUint8Arrays(
  ...arrays
) {

  let totalLength =
    0;


  arrays.forEach(
    function (array) {
      totalLength +=
        array.length;
    }
  );


  const result =
    new Uint8Array(
      totalLength
    );


  let offset =
    0;


  arrays.forEach(
    function (array) {

      result.set(
        array,
        offset
      );

      offset +=
        array.length;
    }
  );


  return result;
}


/*
 * ================================================================
 * BASE64URL
 * ================================================================
 */

function base64UrlEncode(
  text
) {

  const bytes =
    new TextEncoder()
      .encode(text);


  return arrayBufferToBase64Url(
    bytes
  );
}


function arrayBufferToBase64Url(
  buffer
) {

  const bytes =
    new Uint8Array(
      buffer
    );


  let binary =
    "";


  for (
    let i = 0;
    i < bytes.length;
    i++
  ) {

    binary +=
      String.fromCharCode(
        bytes[i]
      );
  }


  return btoa(binary)
    .replace(
      /\+/g,
      "-"
    )
    .replace(
      /\//g,
      "_"
    )
    .replace(
      /=+$/,
      ""
    );
}


/*
 * ================================================================
 * CORS
 * ================================================================
 */

function corsHeaders() {

  return {
    "Access-Control-Allow-Origin":
      "*",

    "Access-Control-Allow-Methods":
      "GET, POST, OPTIONS",

    "Access-Control-Allow-Headers":
      "*"
  };
}
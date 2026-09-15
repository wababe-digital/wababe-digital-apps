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

        const body = await response.text();

        return new Response(body, {
          status: response.status,
          headers: {
            "Content-Type":
              "application/json; charset=utf-8",

            "Cache-Control":
              "public, max-age=300",

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

        headers.set(
          "Content-Disposition",
          'attachment; filename="app.apk"'
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
            "wababe-digital-apps"
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
      "GET, OPTIONS",

    "Access-Control-Allow-Headers":
      "*"
  };
}

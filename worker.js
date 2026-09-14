const GITHUB_REPO =
  "https://github.com/wababe-digital/wababe-digital-apps";

const GITHUB_API =
  "https://api.github.com/repos/wababe-digital/wababe-digital-apps/releases?per_page=100";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // =========================================
    // GITHUB RELEASES API PROXY
    // =========================================
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

        const response = await fetch(GITHUB_API, {
          method: "GET",
          headers: {
            "Accept": "application/vnd.github+json",
            "Authorization": "Bearer " + env.GITHUB_TOKEN,
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "Wababe-Digital-Apps"
          }
        });

        const body = await response.text();

        return new Response(body, {
          status: response.status,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "public, max-age=300",
            ...corsHeaders()
          }
        });

      } catch (error) {

        return new Response(
          JSON.stringify({
            error: "Unable to connect to GitHub API."
          }),
          {
            status: 500,
            headers: {
              "Content-Type": "application/json; charset=utf-8",
              ...corsHeaders()
            }
          }
        );
      }
    }


    // =========================================
    // APK DOWNLOAD
    // =========================================
    if (url.pathname === "/download") {

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

      const apkUrl = url.searchParams.get("url");

      if (!apkUrl) {
        return new Response("APK URL is required.", {
          status: 400,
          headers: corsHeaders()
        });
      }


      // Only allow downloads from Wababe Digital Apps
      if (
        !apkUrl.startsWith(
          GITHUB_REPO + "/releases/download/"
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

        const response = await fetch(apkUrl, {
          method: "GET",
          redirect: "follow"
        });

        if (!response.ok) {
          return new Response(
            "Unable to download APK.",
            {
              status: response.status,
              headers: corsHeaders()
            }
          );
        }


        const headers = new Headers();

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
          response.headers.get("Content-Length");

        if (contentLength) {
          headers.set(
            "Content-Length",
            contentLength
          );
        }


        const cors = corsHeaders();

        Object.entries(cors).forEach(
          ([key, value]) => {
            headers.set(key, value);
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
              "Content-Type": "text/plain",
              ...corsHeaders()
            }
          }
        );
      }
    }


    // =========================================
    // NORMAL WEBSITE FILES
    // =========================================
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders()
      });
    }

    return env.ASSETS.fetch(request);
  }
};


// =========================================
// CORS HEADERS
// =========================================
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods":
      "GET, OPTIONS",
    "Access-Control-Allow-Headers": "*"
  };
}

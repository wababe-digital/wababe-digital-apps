const APK_URL =
"https://github.com/wababe-digital/wababe-digital-apps/releases/download/v1.0.0/Usulus_Salas_Audio.apk";


export default {

  async fetch(request, env) {

    const url = new URL(request.url);


    /*
    =========================
    APK DOWNLOAD PROXY
    =========================
    */

    if (url.pathname === "/download") {

      if (request.method !== "GET") {

        return new Response(
          "Method Not Allowed",
          {
            status: 405,
            headers: {
              "Allow": "GET"
            }
          }
        );

      }


      try {

        /*
        Fetch APK from GitHub.
        */

        const response =
          await fetch(APK_URL, {
            method: "GET",
            redirect: "follow"
          });


        if (!response.ok) {

          return new Response(
            "Unable to download APK.",
            {
              status: response.status
            }
          );

        }


        /*
        Copy important headers.
        */

        const headers =
          new Headers();


        headers.set(
          "Content-Type",
          "application/vnd.android.package-archive"
        );


        headers.set(
          "Content-Disposition",
          'attachment; filename="Usulus_Salas_Audio.apk"'
        );


        headers.set(
          "Cache-Control",
          "public, max-age=3600"
        );


        headers.set(
          "Access-Control-Allow-Origin",
          "*"
        );


        headers.set(
          "Access-Control-Allow-Methods",
          "GET, OPTIONS"
        );


        /*
        Preserve Content-Length when GitHub
        provides it.

        This is important for percentage.
        */

        const contentLength =
          response.headers.get(
            "Content-Length"
          );


        if(contentLength){

          headers.set(
            "Content-Length",
            contentLength
          );

        }


        /*
        Return GitHub's streaming body
        directly to the browser.
        */

        return new Response(
          response.body,
          {
            status: 200,
            headers: headers
          }
        );


      } catch(error) {

        return new Response(
          "Download service error.",
          {
            status: 500,
            headers: {
              "Content-Type":
                "text/plain",
              "Access-Control-Allow-Origin":
                "*"
            }
          }
        );

      }

    }


    /*
    =========================
    CORS PREFLIGHT
    =========================
    */

    if (
      request.method === "OPTIONS"
    ) {

      return new Response(
        null,
        {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, OPTIONS",
            "Access-Control-Allow-Headers": "*"
          }
        }
      );

    }


    /*
    =========================
    WEBSITE
    =========================

    Everything else is served
    from Cloudflare Static Assets.
    */

    return env.ASSETS.fetch(request);

  }

};

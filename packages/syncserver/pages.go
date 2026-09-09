package syncserver

import (
	"html/template"
	"net/http"
)

// Minimal server-rendered landing pages for the links in verification and reset emails,
// used when no external frontend (the cloud portal) handles them. They are deliberately
// tiny and dependency-free: a self-hosted instance is just the API binary.

type pageData struct {
	Title string
	Lead  string
	// VerifyToken, when set, renders a "Confirm email" button that POSTs the token to
	// /v1/auth/verify from the page (never on GET, so link prefetchers can't spend it).
	VerifyToken string
	// AppLink, when set, renders an "Open the Companion app" button plus the link as
	// selectable text (PasteHint introduces it) for devices where the deep link won't open.
	AppLink   string
	PasteHint string
}

var pageTmpl = template.Must(template.New("page").Parse(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{{.Title}} · Companion</title>
<style>
  body { margin: 0; background: #f5f5f3; color: #1a1a18; font: 15px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 480px; margin: 40px auto; padding: 40px; background: #fff; border-radius: 12px; box-sizing: border-box; }
  .logo { width: 28px; height: 28px; border-radius: 8px; background: #f76808; margin-bottom: 24px; }
  h1 { font-size: 22px; margin: 0 0 16px; }
  p { margin: 0 0 12px; }
  .muted { font-size: 13px; color: #7b7b75; }
  code { display: block; word-break: break-all; font-size: 13px; padding: 10px 12px; background: #f5f5f3; border-radius: 8px; }
  .button { display: inline-block; margin: 12px 0; padding: 11px 20px; border: 0; border-radius: 8px; background: #f76808; color: #fff; font: inherit; font-weight: 600; text-decoration: none; cursor: pointer; }
  .button[disabled] { opacity: .6; cursor: default; }
  .ok { color: #1c7c3a; } .err { color: #b3261e; }
</style>
</head>
<body>
<main>
  <div class="logo"></div>
  <h1>{{.Title}}</h1>
  <p>{{.Lead}}</p>
  {{if .VerifyToken}}
  <button class="button" id="confirm">Confirm email</button>
  <p id="result"></p>
  <script>
    (function () {
      var btn = document.getElementById("confirm"), out = document.getElementById("result");
      btn.addEventListener("click", function () {
        btn.disabled = true;
        fetch(location.pathname, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: {{.VerifyToken}} }) })
          .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); })
          .then(function (res) {
            out.className = res.ok ? "ok" : "err";
            out.textContent = res.ok ? "Your email is confirmed. You can close this tab." : (res.body && res.body.error) || "Verification failed.";
            if (!res.ok) btn.disabled = false;
          })
          .catch(function () { out.className = "err"; out.textContent = "Could not reach the server. Try again."; btn.disabled = false; });
      });
    })();
  </script>
  {{end}}
  {{if .AppLink}}
  <a class="button" href="{{.AppLink}}">Open the Companion app</a>
  <p class="muted">{{.PasteHint}}</p>
  <code>{{.AppLink}}</code>
  {{end}}
</main>
</body>
</html>
`))

// renderPage writes a landing page. Template errors after headers are sent are ignored; the
// template is static and parsed at init, so the only realistic failure is a closed connection.
func renderPage(w http.ResponseWriter, status int, d pageData) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = pageTmpl.Execute(w, d)
}

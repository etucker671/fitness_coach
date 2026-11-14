import { AuthorizationError, CimdFetchError } from '@cloudflare/workers-oauth-provider';
import { secretsMatch } from './shared.js';

// The sign-in page an app sends you to (step 3 of the OAuth flow).
// GET shows the page; POST handles Allow / Deny.
// There is one user (you), so "signing in" is just the owner password.
export async function handleAuthorize(request, env) {
  const oauth = env.OAUTH_PROVIDER; // helpers the provider adds to env
  try {
    if (request.method === 'GET') {
      const authRequest = await oauth.parseAuthRequest(request); // checks client, redirect URI, PKCE
      const details = await oauth.describeConsent(authRequest); // facts to show on the page
      const consent = await oauth.beginConsent(authRequest); // one-time handle + safety headers
      consent.headers.set('Content-Type', 'text/html; charset=utf-8');
      return new Response(consentPage(details, consent.handle), { headers: consent.headers });
    }

    if (request.method === 'POST') {
      const form = await request.formData();
      const handle = String(form.get('handle') ?? '');

      if (form.get('decision') !== 'approve') {
        const denied = await oauth.denyConsent(request, handle); // tells the app "access_denied"
        return new Response(null, { status: 302, headers: denied.headers });
      }

      // Check the password BEFORE approveConsent, which uses up the handle.
      // On a wrong password the handle stays valid, so Back + retry works.
      if (!(await secretsMatch(String(form.get('password') ?? ''), env.OWNER_PASSWORD))) {
        return textPage('Wrong password. Go back and try again.', 401);
      }

      const approved = await oauth.approveConsent(request, handle, { scope: ['fitness'] });
      const { redirectTo } = await oauth.completeAuthorization({
        request: approved.request, // the original request, from storage (not from the form)
        userId: 'owner',
        metadata: {},
        scope: approved.request.scope,
        props: { userId: 'owner', via: 'oauth' }, // what the MCP handler receives as ctx.props
      });
      approved.headers.set('Location', redirectTo); // back to the app, carrying the one-time code
      return new Response(null, { status: 302, headers: approved.headers });
    }

    return textPage('Method not allowed.', 405);
  } catch (error) {
    // Safe to send the error back to the app only if its redirect URI was validated.
    if (error instanceof AuthorizationError && error.redirectTo) {
      return Response.redirect(error.redirectTo, 302);
    }
    if (error instanceof AuthorizationError) return textPage(error.description, 400);
    if (error instanceof CimdFetchError) return textPage('This app could not be verified.', 400);
    throw error; // a bug or outage: let it surface as a 500
  }
}

// Everything from the client (its name, the redirect host) is chosen by whoever
// registered it, so it is escaped before going into HTML.
const escape = (value) => String(value).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const textPage = (message, status) =>
  new Response(escape(message), { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });

function consentPage(details, handle) {
  const name = escape(details.clientName);
  const origin = details.clientDomain
    ? `Published by <strong>${escape(details.clientDomain)}</strong>.`
    : 'This app registered itself; its name is not verified.';
  const loopbackWarning = details.redirectIsLoopback
    ? '<p class="warn"><strong>This sends access to an app on a computer, not a website.</strong> Continue only if you just started signing in from it.</p>'
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Allow ${name}?</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 28rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; }
  input[type=password] { width: 100%; padding: .6rem; font-size: 1rem; box-sizing: border-box; }
  button { padding: .6rem 1.2rem; font-size: 1rem; margin-right: .5rem; }
  .warn { background: #fff3cd; padding: .6rem; border-radius: .3rem; }
</style>
</head>
<body>
<h1>Allow ${name} to use your fitness data?</h1>
<p>${origin} Access will be sent to <strong>${escape(details.redirectHost)}</strong>.</p>
${loopbackWarning}
<p>It will be able to read and change your meals, exercise, body metrics, notes and goals.</p>
<form method="post">
  <input type="hidden" name="handle" value="${escape(handle)}">
  <p><label>Owner password<br><input type="password" name="password" autocomplete="current-password" autofocus></label></p>
  <p><button name="decision" value="approve">Allow</button><button name="decision" value="deny">Deny</button></p>
</form>
</body>
</html>`;
}

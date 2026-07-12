import { LegalPage } from "../src/components/LegalPage";

export default function Terms() {
  return (
    <LegalPage
      heading="Terms of Service"
      updated="July 12, 2026"
      intro="These terms cover your use of the Companion apps and the optional Companion Cloud service. The app itself is free and open source; using it means you agree to what's below."
      toc={[
        { href: "#acceptance", label: "Acceptance" },
        { href: "#license", label: "The software license" },
        { href: "#account", label: "Your account" },
        { href: "#use", label: "Acceptable use" },
        { href: "#content", label: "Your content" },
        { href: "#warranty", label: "Disclaimer & liability" },
        { href: "#changes", label: "Changes to these terms" },
      ]}
    >
      <h2 id="acceptance">Acceptance</h2>
      <p>
        By downloading, installing, or using Companion, you agree to these terms. If you don't agree, please don't use
        the app or the cloud service. If you're using Companion on behalf of an organization, you're agreeing on its
        behalf.
      </p>

      <h2 id="license">The software license</h2>
      <p>
        Companion's source code is released under the <strong>MIT License</strong>. You're free to use, copy, modify,
        and self-host it, subject to that license. The Companion name and logo are trademarks and aren't covered by the
        code license — please don't use them to imply endorsement.
      </p>

      <h2 id="account">Your account</h2>
      <p>
        An account is only required for Companion Cloud. You're responsible for keeping your credentials secure and for
        the activity under your account. You must be old enough to form a binding contract in your jurisdiction to
        create one.
      </p>

      <h2 id="use">Acceptable use</h2>
      <p>Use Companion lawfully. When using the cloud service, you agree not to:</p>
      <ul>
        <li>Store or distribute unlawful content, or infringe someone else's rights.</li>
        <li>Attempt to disrupt, overload, or gain unauthorized access to our systems.</li>
        <li>Resell the hosted service without our written permission.</li>
      </ul>
      <p>Self-hosting your own instance is explicitly encouraged and isn't limited by these usage rules.</p>

      <h2 id="content">Your content</h2>
      <p>
        You own everything you create in Companion. We claim no rights over your notes, tasks, or habits. You grant us
        only the limited permission needed to store and sync your data when you use the cloud — nothing more. You're
        responsible for keeping your own backups; see <a href="/docs">Using our cloud</a>.
      </p>

      <h2 id="warranty">Disclaimer &amp; liability</h2>
      <p>
        Companion is provided <strong>"as is," without warranties</strong> of any kind. We work hard to keep the cloud
        service available and reliable, but we can't guarantee it will be uninterrupted or error-free. To the fullest
        extent permitted by law, Companion and its contributors aren't liable for any indirect or incidental damages
        arising from your use of the app or service.
      </p>

      <h2 id="changes">Changes to these terms</h2>
      <p>
        We may update these terms as Companion evolves. Material changes will be reflected in the date above and noted
        in the repository. Continued use after a change means you accept the revised terms. Questions?{" "}
        <a href="/contact">Contact us</a>.
      </p>
    </LegalPage>
  );
}

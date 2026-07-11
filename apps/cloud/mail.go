package main

import (
	"crypto/tls"
	"embed"
	"fmt"
	"log/slog"
	"net"
	"net/smtp"
	"os"
	"strings"
)

// Rendered React Email templates (built from apps/cloud/emails). Each is HTML with
// {{placeholder}} tokens the mailer substitutes per recipient. See apps/cloud/emails.
//
//go:embed all:emails/dist
var emailTemplates embed.FS

// mailer sends transactional email over SMTP. Configuration is read from the environment
// at runtime; when SMTP is unconfigured (dev), send() logs the message (and any verify
// link) instead of erroring, so the flow is fully exercisable without a mail server.
type mailer struct {
	host string // SMTP_HOST
	port string // SMTP_PORT (default 587)
	user string // SMTP_USERNAME
	pass string // SMTP_PASSWORD
	from string // SMTP_FROM (envelope + header From)
}

func newMailer() *mailer {
	m := &mailer{
		host: os.Getenv("SMTP_HOST"),
		port: os.Getenv("SMTP_PORT"),
		user: os.Getenv("SMTP_USERNAME"),
		pass: os.Getenv("SMTP_PASSWORD"),
		from: os.Getenv("SMTP_FROM"),
	}
	if m.port == "" {
		m.port = "587"
	}
	if m.from == "" {
		m.from = "no-reply@localhost"
	}
	// Announce the mail configuration at boot so "is SMTP set up?" is answerable from the
	// logs — the usual cause of "emails aren't sending" is SMTP_HOST not reaching the process.
	if m.host == "" {
		slog.Warn("mail: SMTP not configured (SMTP_HOST unset) — verification/reset emails will be logged, not sent")
	} else {
		slog.Info("mail: SMTP configured", "host", m.host, "port", m.port, "auth", m.user != "", "from", m.from)
	}
	return m
}

func (m *mailer) configured() bool { return m.host != "" }

// template loads an embedded email template and substitutes {{key}} placeholders.
func (m *mailer) template(name string, vars map[string]string) (string, error) {
	raw, err := emailTemplates.ReadFile("emails/dist/" + name)
	if err != nil {
		return "", fmt.Errorf("email template %s: %w", name, err)
	}
	html := string(raw)
	for k, v := range vars {
		html = strings.ReplaceAll(html, "{{"+k+"}}", v)
	}
	return html, nil
}

// send delivers an HTML email. Without SMTP configured it logs the message (with any link)
// so dev can proceed without a mail server. Every outcome is logged so failures are visible.
func (m *mailer) send(to, subject, htmlBody string) error {
	if !m.configured() {
		slog.Warn("mail: SMTP not configured; email NOT sent (set SMTP_HOST to send)",
			"to", to, "subject", subject, "preview", previewLinks(htmlBody))
		return nil
	}
	if err := m.deliver(to, buildMessage(m.from, to, subject, htmlBody)); err != nil {
		slog.Error("mail: send failed", "to", to, "host", m.host, "port", m.port, "err", err)
		return err
	}
	slog.Info("mail: sent", "to", to, "subject", subject)
	return nil
}

// deliver runs the SMTP conversation. It supports implicit TLS (port 465, dial TLS
// directly) and STARTTLS (587/25, upgrade the plaintext connection when the server offers
// it) — net/smtp.SendMail only handles the latter, so a 465 provider would otherwise fail.
func (m *mailer) deliver(to string, msg []byte) error {
	addr := net.JoinHostPort(m.host, m.port)
	tlsCfg := &tls.Config{ServerName: m.host}

	var client *smtp.Client
	var err error
	if m.port == "465" {
		conn, derr := tls.Dial("tcp", addr, tlsCfg)
		if derr != nil {
			return fmt.Errorf("tls dial %s: %w", addr, derr)
		}
		if client, err = smtp.NewClient(conn, m.host); err != nil {
			return fmt.Errorf("smtp client: %w", err)
		}
	} else {
		if client, err = smtp.Dial(addr); err != nil {
			return fmt.Errorf("dial %s: %w", addr, err)
		}
		if ok, _ := client.Extension("STARTTLS"); ok {
			if err := client.StartTLS(tlsCfg); err != nil {
				client.Close()
				return fmt.Errorf("starttls: %w", err)
			}
		}
	}
	defer client.Close()

	if m.user != "" {
		if err := client.Auth(smtp.PlainAuth("", m.user, m.pass, m.host)); err != nil {
			return fmt.Errorf("auth: %w", err)
		}
	}
	if err := client.Mail(m.from); err != nil {
		return fmt.Errorf("mail from %q: %w", m.from, err)
	}
	if err := client.Rcpt(to); err != nil {
		return fmt.Errorf("rcpt to %q: %w", to, err)
	}
	wc, err := client.Data()
	if err != nil {
		return fmt.Errorf("data: %w", err)
	}
	if _, err := wc.Write(msg); err != nil {
		wc.Close()
		return fmt.Errorf("write body: %w", err)
	}
	if err := wc.Close(); err != nil {
		return fmt.Errorf("close body: %w", err)
	}
	return client.Quit()
}

// buildMessage assembles a minimal RFC 5322 HTML message.
func buildMessage(from, to, subject, htmlBody string) []byte {
	var b strings.Builder
	b.WriteString("From: " + from + "\r\n")
	b.WriteString("To: " + to + "\r\n")
	b.WriteString("Subject: " + subject + "\r\n")
	b.WriteString("MIME-Version: 1.0\r\n")
	b.WriteString("Content-Type: text/html; charset=UTF-8\r\n")
	b.WriteString("\r\n")
	b.WriteString(htmlBody)
	return []byte(b.String())
}

// previewLinks pulls href URLs out of an HTML body for the dev log, so the verification
// link is visible without configuring SMTP.
func previewLinks(html string) string {
	var links []string
	for _, part := range strings.Split(html, `href="`)[1:] {
		if end := strings.IndexByte(part, '"'); end > 0 {
			if u := part[:end]; strings.HasPrefix(u, "http") {
				links = append(links, u)
			}
		}
	}
	if len(links) == 0 {
		return "(no links)"
	}
	return "links: " + strings.Join(links, " ")
}

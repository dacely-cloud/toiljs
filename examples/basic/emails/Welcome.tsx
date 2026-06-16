// An email template, authored as a normal React component. At `toiljs build`
// it is rendered ONCE to static, inline-CSS HTML with `{{name}}`/`{{code}}`
// holes (email clients run no JS), and the generated `server/_emails.ts`
// exposes a typed `Emails.Welcome.send(to, code, name)` the server calls.
//
// Email clients strip <style>/external CSS, so styles must end up inline. You
// can write inline `style={{}}` directly, or import a stylesheet and its rules
// are inlined for you at build: keep email-only styles next to the email (here,
// `./styles/email.css`), or reuse existing project CSS with `import
// 'client/styles/...'`. Preview and edit live at /__toil/emails during `toiljs dev`.
import './styles/email.css';

export const subject = 'Welcome, {{name}}!';

export default function Welcome({ name, code }: { name: string; code: string }) {
    return (
        <table width="100%" cellPadding={0} cellSpacing={0} className="email-card">
            <tbody>
                <tr>
                    <td style={{ padding: '32px' }}>
                        <h1 className="email-title">Welcome, {name}!</h1>
                        <p className="email-text">
                            Thanks for signing up. Your verification code is <b className="email-code">{code}</b>.
                        </p>
                        <p className="email-fine">If you didn&apos;t request this, you can ignore this email.</p>
                    </td>
                </tr>
            </tbody>
        </table>
    );
}

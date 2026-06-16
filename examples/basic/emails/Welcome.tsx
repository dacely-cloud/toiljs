// An email template, authored as a normal React component. At `toiljs build`
// it is rendered ONCE to static, inline-CSS HTML with `{{name}}`/`{{code}}`
// holes (email clients run no JS), and the generated `server/_emails.ts`
// exposes a typed `Emails.Welcome.send(to, code, name)` the server calls.
//
// Email clients strip <style>/external CSS, so styles must end up inline. The
// rules in `./styles/email.css` are inlined for you at build (they match the
// toiljs demo's dark brand from `client/styles/main.css`); table layout +
// solid-color fallbacks keep it intact in Outlook/Gmail. Preview and edit live
// at /__toil/emails during `toiljs dev`.
import './styles/email.css';

export const subject = 'Welcome to toiljs, {{name}}';

export default function Welcome({ name, code }: { name: string; code: string }) {
    return (
        <table width="100%" cellPadding={0} cellSpacing={0} className="email-bg">
            <tbody>
                <tr>
                    <td align="center" style={{ padding: '40px 16px' }}>
                        <table
                            cellPadding={0}
                            cellSpacing={0}
                            className="email-card"
                            style={{ width: '100%', maxWidth: '480px' }}
                        >
                            <tbody>
                                {/* Signature gradient hairline. */}
                                <tr>
                                    <td className="email-bar">&nbsp;</td>
                                </tr>

                                {/* Brand. */}
                                <tr>
                                    <td style={{ padding: '30px 36px 0' }}>
                                        <table cellPadding={0} cellSpacing={0}>
                                            <tbody>
                                                <tr>
                                                    <td className="email-mark">✦</td>
                                                    <td className="email-brand">toiljs</td>
                                                </tr>
                                            </tbody>
                                        </table>
                                    </td>
                                </tr>

                                {/* Greeting + intro. */}
                                <tr>
                                    <td style={{ padding: '22px 36px 0' }}>
                                        <h1 className="email-title">Welcome aboard, {name} 👋</h1>
                                        <p className="email-text">
                                            You&apos;re in. Enter this verification code to finish setting up your
                                            account:
                                        </p>
                                    </td>
                                </tr>

                                {/* The code. */}
                                <tr>
                                    <td align="center" style={{ padding: '22px 36px 4px' }}>
                                        <span className="email-code">{code}</span>
                                    </td>
                                </tr>

                                {/* CTA. */}
                                <tr>
                                    <td align="center" style={{ padding: '20px 36px 4px' }}>
                                        <a href="https://toil.org" className="email-btn">
                                            Open toiljs
                                        </a>
                                    </td>
                                </tr>

                                {/* Fine print. */}
                                <tr>
                                    <td style={{ padding: '18px 36px 30px' }}>
                                        <p className="email-fine">
                                            This code expires soon. If you didn&apos;t create a toiljs account, you can
                                            safely ignore this email.
                                        </p>
                                    </td>
                                </tr>

                                {/* Footer. */}
                                <tr>
                                    <td className="email-footer">
                                        toiljs — the most performant React framework
                                    </td>
                                </tr>
                            </tbody>
                        </table>
                    </td>
                </tr>
            </tbody>
        </table>
    );
}

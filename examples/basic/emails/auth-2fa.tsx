// RESERVED auth override: `emails/auth-2fa.tsx` replaces the built-in two-factor
// CODE message that `server.auth` sends at login (when 2FA is on) and during 2FA
// setup. It MUST read the `code` prop; rendered once at build to static inline-CSS
// HTML with a `{{code}}` hole. NOTE: the SUBJECT of a 2FA email stays contextual
// (login vs setup) and is set by the framework, so any `export const subject`
// here is intentionally ignored. See docs/auth/emails.md.
import './styles/email.css';

export default function Auth2fa({ code }: { code: string }) {
    return (
        <table width="100%" cellPadding={0} cellSpacing={0} className="email-bg">
            <tbody>
                <tr>
                    <td align="center" style={{ padding: '40px 16px' }}>
                        <table
                            cellPadding={0}
                            cellSpacing={0}
                            className="email-card"
                            style={{ width: '100%', maxWidth: '480px' }}>
                            <tbody>
                                <tr>
                                    <td className="email-bar">&nbsp;</td>
                                </tr>

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

                                <tr>
                                    <td style={{ padding: '22px 36px 0' }}>
                                        <h1 className="email-title">Your verification code</h1>
                                        <p className="email-text">
                                            Enter this code to finish signing in to toiljs.
                                        </p>
                                    </td>
                                </tr>

                                <tr>
                                    <td align="center" style={{ padding: '24px 36px 4px' }}>
                                        <span className="email-code">{code}</span>
                                    </td>
                                </tr>

                                <tr>
                                    <td style={{ padding: '20px 36px 30px' }}>
                                        <p className="email-fine">
                                            This code expires in a few minutes. If you didn&apos;t try to sign in, you
                                            can safely ignore this email.
                                        </p>
                                    </td>
                                </tr>

                                <tr>
                                    <td className="email-footer">toiljs, one build, the whole planet</td>
                                </tr>
                            </tbody>
                        </table>
                    </td>
                </tr>
            </tbody>
        </table>
    );
}

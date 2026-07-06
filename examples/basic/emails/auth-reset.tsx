// RESERVED auth override: `emails/auth-reset.tsx` replaces the built-in
// password-reset message that `server.auth` sends from POST /auth/reset/request.
// It MUST read the `link` prop (the reset URL). Rendered once at build to static
// inline-CSS HTML with a `{{link}}` hole. See docs/auth/emails.md.
import './styles/email.css';

export const subject = 'Reset your toiljs password';

export default function AuthReset({ link }: { link: string }) {
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
                                        <h1 className="email-title">Reset your password</h1>
                                        <p className="email-text">
                                            We got a request to reset your toiljs password. Tap below to choose a new
                                            one. The link is good for one hour.
                                        </p>
                                    </td>
                                </tr>

                                <tr>
                                    <td align="center" style={{ padding: '24px 36px 4px' }}>
                                        <a href={link} className="email-btn">
                                            Reset password
                                        </a>
                                    </td>
                                </tr>

                                <tr>
                                    <td style={{ padding: '18px 36px 30px' }}>
                                        <p className="email-fine">
                                            Or paste this link into your browser:
                                            <br />
                                            <span style={{ wordBreak: 'break-all', color: '#8b9ab4' }}>{link}</span>
                                        </p>
                                        <p className="email-fine" style={{ paddingTop: '10px' }}>
                                            If you didn&apos;t request this, ignore this email. Your password stays the
                                            same.
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

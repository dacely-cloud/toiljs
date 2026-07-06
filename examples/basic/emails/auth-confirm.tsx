// RESERVED auth override: `emails/auth-confirm.tsx` replaces the built-in
// email-verification message that `server.auth` sends at registration. It MUST
// read the `link` prop (the confirm URL auth hands it); at build the component
// is rendered once to static inline-CSS HTML with a `{{link}}` hole. The subject
// below overrides the default "Confirm your account". See docs/auth/emails.md.
import './styles/email.css';

export const subject = 'Confirm your toiljs account';

export default function AuthConfirm({ link }: { link: string }) {
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
                                        <h1 className="email-title">Confirm your email</h1>
                                        <p className="email-text">
                                            Tap the button below to verify your email and finish creating your toiljs
                                            account.
                                        </p>
                                    </td>
                                </tr>

                                <tr>
                                    <td align="center" style={{ padding: '24px 36px 4px' }}>
                                        <a href={link} className="email-btn">
                                            Verify email
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
                                            If you didn&apos;t create a toiljs account, you can safely ignore this
                                            email.
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

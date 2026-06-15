// An email template, authored as a normal React component. At `toiljs build`
// it is rendered ONCE to static, inline-CSS HTML with `{{name}}`/`{{code}}`
// holes (email clients run no JS), and the generated `server/_emails.ts`
// exposes a typed `Emails.Welcome.send(to, code, name)` the server calls.
//
// Use inline `style={{}}` (email clients strip <style>/external CSS; a CSS file
// imported here is inlined by juice at build). Props are the dynamic fields.

export const subject = 'Welcome, {{name}}!';

export default function Welcome({ name, code }: { name: string; code: string }) {
    return (
        <table
            width="100%"
            cellPadding={0}
            cellSpacing={0}
            style={{ fontFamily: 'Arial, sans-serif', backgroundColor: '#f6f7f9' }}
        >
            <tbody>
                <tr>
                    <td style={{ padding: '32px' }}>
                        <h1 style={{ color: '#111827', margin: '0 0 12px', fontSize: '22px' }}>
                            Welcome, {name}!
                        </h1>
                        <p style={{ color: '#4b5563', fontSize: '15px', lineHeight: '22px' }}>
                            Thanks for signing up. Your verification code is{' '}
                            <b style={{ color: '#111827' }}>{code}</b>.
                        </p>
                        <p style={{ color: '#9ca3af', fontSize: '12px', marginTop: '24px' }}>
                            If you didn&apos;t request this, you can ignore this email.
                        </p>
                    </td>
                </tr>
            </tbody>
        </table>
    );
}

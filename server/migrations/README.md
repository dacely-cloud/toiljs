# migrations/

ToilDB schema migrations. One file per evolving `@data` value type, named `<Type>.migration.ts`
(e.g. `User.migration.ts`).

Each file keeps the OLD `@data` shapes (e.g. `UserV1`) alongside the `@migrate` transform(s) that
carry old records forward, and imports the CURRENT value type from the app. The build
auto-discovers every `*.migration.ts` under the project.

Do NOT put `@migrate` anywhere else: a `@migrate` outside a `*.migration.ts` file in a
`migrations/` folder is a compile error.

## Example

`User.migration.ts`:

```ts
import { User } from '../models/User';

// The previous on-disk shape of a User record.
@data
export class UserV1 {
    name: string = '';
}

// Carry a UserV1 forward into the current User. Runs once per record on read.
@migrate
export function up(old: UserV1, into: User): void {
    into.name = old.name;
}
```

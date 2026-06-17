/** Request body for `POST /guestbook` - a new signature to append. */
@data
export class NewMessage {
    author: string = '';
    message: string = '';
}

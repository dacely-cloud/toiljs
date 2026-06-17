/** One signed guestbook entry, stored as a ToilDB `events` record. */
@data
export class GuestEntry {
    author: string = '';
    message: string = '';
    at: u64 = 0;
    constructor(author: string = '', message: string = '', at: u64 = 0) {
        this.author = author;
        this.message = message;
        this.at = at;
    }
}

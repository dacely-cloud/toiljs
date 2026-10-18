@external('env','image.process')
declare function imageProcess(ptr:usize,len:i32,mode:i32,width:i32,height:i32,quality:i32):i32;
@external('env','image.take_result')
declare function imageTake(ptr:usize,cap:i32):i32;

export enum ImageError {None=0,Invalid=2,Unsupported=3,Limit=4,Busy=5,Timeout=6,Unavailable=7,Options=8,Kind=9,Quota=10}
export enum ImageFormat {Png=1,Jpeg=2}
export class ImageResult {
    error:ImageError=ImageError.None;
    bytes:Uint8Array=new Uint8Array(0);
    width:u32=0;
    height:u32=0;
    format:ImageFormat=ImageFormat.Png;
    get ok():bool {return this.error==ImageError.None;}
    get contentType():string {return this.format==ImageFormat.Jpeg?'image/jpeg':'image/png';}
}
export class Images {
    private static run(input:Uint8Array,mode:i32,width:i32,height:i32,quality:i32):ImageResult {
        const result=new ImageResult();
        const status=imageProcess(input.dataStart,input.byteLength,mode,width,height,quality);
        if(status<0){result.error=<ImageError>(-status);return result;}
        const frame=new Uint8Array(status);
        if(imageTake(frame.dataStart,status)!=status||status<14||frame[0]!=1){result.error=ImageError.Unavailable;return result;}
        result.width=load<u32>(frame.dataStart+1);result.height=load<u32>(frame.dataStart+5);result.format=<ImageFormat>frame[9];
        const length=load<u32>(frame.dataStart+10);
        if(length!=<u32>(status-14)){result.error=ImageError.Unavailable;return result;}
        result.bytes=frame.subarray(14);return result;
    }
    /** Re-encode without EXIF/XMP/IPTC/text/comments, applying orientation.
     * Retains ICC profiles and PNG color descriptors. JPEG is re-encoded. */
    static stripExif(input:Uint8Array,quality:i32=90):ImageResult {return Images.run(input,0,0,0,quality);}
    /** Fit inside the box, retaining aspect ratio and avoiding enlargement. */
    static resize(input:Uint8Array,width:i32,height:i32,quality:i32=90):ImageResult {return Images.run(input,1,width,height,quality);}
    /** Center crop to the requested aspect ratio, avoiding enlargement. */
    static thumbnail(input:Uint8Array,width:i32,height:i32,quality:i32=90):ImageResult {return Images.run(input,2,width,height,quality);}
}

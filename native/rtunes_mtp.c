#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <stdbool.h>
#include <string.h>
#include <strings.h>
#include <sys/stat.h>
#include <CoreFoundation/CoreFoundation.h>
#include <IOKit/IOKitLib.h>
#include <IOKit/IOCFPlugIn.h>
#include <IOKit/usb/IOUSBLib.h>

#pragma pack(push, 1)
typedef struct {
    uint32_t length;
    uint16_t type;
    uint16_t code;
    uint32_t transaction_id;
    uint32_t params[5];
} MTPCommand;
#pragma pack(pop)

typedef struct {
    IOUSBDeviceInterface182 **dev;
    IOUSBInterfaceInterface190 **intf;
    UInt8 pipeIn;
    UInt8 pipeOut;
    uint32_t tx;
    char vendor[128];
    char product[128];
    char serial[128];
    int vendorId;
    int productId;
    uint32_t locationId;
    bool busy;
} MTPSession;

static void json_escape(const char *src, char *dst, size_t dst_max) {
    size_t j = 0;
    for (size_t i = 0; src && src[i] && j + 6 < dst_max; i++) {
        unsigned char c = (unsigned char)src[i];
        if (c == '"' || c == '\\') {
            dst[j++] = '\\';
            dst[j++] = (char)c;
        } else if (c == '\n') {
            dst[j++] = '\\';
            dst[j++] = 'n';
        } else if (c == '\r') {
            dst[j++] = '\\';
            dst[j++] = 'r';
        } else if (c == '\t') {
            dst[j++] = '\\';
            dst[j++] = 't';
        } else if (c >= 32) {
            dst[j++] = (char)c;
        }
    }
    dst[j] = 0;
}

static void read_mtp_string(const uint8_t *buf, size_t max_len, size_t *offset, char *out, size_t out_max) {
    if (*offset >= max_len) { out[0] = 0; return; }
    uint8_t num_chars = buf[*offset];
    (*offset) += 1;
    if (num_chars == 0) { out[0] = 0; return; }
    size_t idx = 0;
    for (uint8_t i = 0; i < num_chars && (*offset + 1) < max_len; i++) {
        uint16_t ch = buf[*offset] | (buf[*offset + 1] << 8);
        (*offset) += 2;
        if (ch == 0) break;
        if (ch < 0x80) {
            if (idx + 1 < out_max) out[idx++] = (char)ch;
        } else if (ch < 0x800) {
            if (idx + 2 < out_max) {
                out[idx++] = (char)(0xC0 | (ch >> 6));
                out[idx++] = (char)(0x80 | (ch & 0x3F));
            }
        } else {
            if (idx + 3 < out_max) {
                out[idx++] = (char)(0xE0 | (ch >> 12));
                out[idx++] = (char)(0x80 | ((ch >> 6) & 0x3F));
                out[idx++] = (char)(0x80 | (ch & 0x3F));
            }
        }
    }
    out[idx] = 0;
}

static size_t write_mtp_string(uint8_t *buf, const char *str) {
    if (!str || str[0] == 0) {
        buf[0] = 0;
        return 1;
    }
    uint16_t u16[256];
    size_t ulen = 0;
    const unsigned char *p = (const unsigned char *)str;
    while (*p && ulen < 253) {
        if (*p < 0x80) {
            u16[ulen++] = *p++;
        } else if ((*p & 0xE0) == 0xC0 && (p[1] & 0xC0) == 0x80) {
            u16[ulen++] = ((p[0] & 0x1F) << 6) | (p[1] & 0x3F);
            p += 2;
        } else if ((*p & 0xF0) == 0xE0 && (p[1] & 0xC0) == 0x80 && (p[2] & 0xC0) == 0x80) {
            u16[ulen++] = ((p[0] & 0x0F) << 12) | ((p[1] & 0x3F) << 6) | (p[2] & 0x3F);
            p += 3;
        } else {
            u16[ulen++] = '?';
            p++;
        }
    }
    buf[0] = (uint8_t)(ulen + 1);
    size_t off = 1;
    for (size_t i = 0; i < ulen; i++) {
        buf[off++] = (uint8_t)(u16[i] & 0xFF);
        buf[off++] = (uint8_t)((u16[i] >> 8) & 0xFF);
    }
    buf[off++] = 0;
    buf[off++] = 0;
    return off;
}

static void get_io_string_prop(io_service_t service, CFStringRef key, char *out, size_t out_max) {
    out[0] = 0;
    CFTypeRef ref = IORegistryEntryCreateCFProperty(service, key, kCFAllocatorDefault, 0);
    if (ref) {
        if (CFGetTypeID(ref) == CFStringGetTypeID()) {
            CFStringGetCString((CFStringRef)ref, out, out_max, kCFStringEncodingUTF8);
        }
        CFRelease(ref);
    }
}

static int get_io_int_prop(io_service_t service, CFStringRef key) {
    int val = 0;
    CFTypeRef ref = IORegistryEntryCreateCFProperty(service, key, kCFAllocatorDefault, 0);
    if (ref) {
        if (CFGetTypeID(ref) == CFNumberGetTypeID()) {
            CFNumberGetValue((CFNumberRef)ref, kCFNumberIntType, &val);
        }
        CFRelease(ref);
    }
    return val;
}

static int read_container(MTPSession *s, uint8_t **out_buf, uint32_t *out_len, uint16_t *out_type, uint16_t *out_code) {
    uint8_t hdr[512];
    UInt32 rlen = sizeof(hdr);
    IOReturn kr = (*s->intf)->ReadPipeTO(s->intf, s->pipeIn, hdr, &rlen, 6000, 6000);
    if (kr != KERN_SUCCESS || rlen < 12) return -1;
    uint32_t total_len = *(uint32_t *)hdr;
    *out_type = *(uint16_t *)(hdr + 4);
    *out_code = *(uint16_t *)(hdr + 6);
    uint8_t *buf = (uint8_t *)malloc(total_len > rlen ? total_len : rlen);
    if (!buf) return -1;
    memcpy(buf, hdr, rlen);
    uint32_t got = rlen;
    while (got < total_len) {
        UInt32 chunk = total_len - got;
        if (chunk > 65536) chunk = 65536;
        kr = (*s->intf)->ReadPipeTO(s->intf, s->pipeIn, buf + got, &chunk, 8000, 8000);
        if (kr != KERN_SUCCESS || chunk == 0) break;
        got += chunk;
    }
    *out_buf = buf;
    *out_len = got;
    return 0;
}

static int open_mtp_session(MTPSession *s) {
    memset(s, 0, sizeof(*s));
    CFMutableDictionaryRef matchingDict = IOServiceMatching(kIOUSBDeviceClassName);
    io_iterator_t iter;
    if (IOServiceGetMatchingServices(kIOMainPortDefault, matchingDict, &iter) != KERN_SUCCESS) return -1;

    io_service_t device;
    while ((device = IOIteratorNext(iter))) {
        char vendor[128] = {0}, product[128] = {0}, serial[128] = {0};
        get_io_string_prop(device, CFSTR("USB Vendor Name"), vendor, sizeof(vendor));
        if (!vendor[0]) get_io_string_prop(device, CFSTR("kUSBVendorString"), vendor, sizeof(vendor));
        get_io_string_prop(device, CFSTR("USB Product Name"), product, sizeof(product));
        if (!product[0]) get_io_string_prop(device, CFSTR("kUSBProductString"), product, sizeof(product));
        get_io_string_prop(device, CFSTR("kUSBSerialNumberString"), serial, sizeof(serial));
        if (!serial[0]) get_io_string_prop(device, CFSTR("USB Serial Number"), serial, sizeof(serial));
        int vid = get_io_int_prop(device, CFSTR("idVendor"));
        int pid = get_io_int_prop(device, CFSTR("idProduct"));
        uint32_t loc = (uint32_t)get_io_int_prop(device, CFSTR("locationID"));

        IOCFPlugInInterface **plugIn = NULL; SInt32 score;
        if (IOCreatePlugInInterfaceForService(device, kIOUSBDeviceUserClientTypeID, kIOCFPlugInInterfaceID, &plugIn, &score) != KERN_SUCCESS || !plugIn) {
            IOObjectRelease(device);
            continue;
        }
        IOUSBDeviceInterface182 **dev = NULL;
        (*plugIn)->QueryInterface(plugIn, CFUUIDGetUUIDBytes(kIOUSBDeviceInterfaceID182), (LPVOID *)&dev);
        (*plugIn)->Release(plugIn);
        if (!dev) { IOObjectRelease(device); continue; }

        IOUSBFindInterfaceRequest req = { kIOUSBFindInterfaceDontCare, kIOUSBFindInterfaceDontCare, kIOUSBFindInterfaceDontCare, kIOUSBFindInterfaceDontCare };
        io_iterator_t intfIter;
        if ((*dev)->CreateInterfaceIterator(dev, &req, &intfIter) == KERN_SUCCESS) {
            io_service_t intfService;
            while ((intfService = IOIteratorNext(intfIter))) {
                char intfStr[64] = {0};
                get_io_string_prop(intfService, CFSTR("kUSBString"), intfStr, sizeof(intfStr));
                IOCFPlugInInterface **iPlug = NULL;
                if (IOCreatePlugInInterfaceForService(intfService, kIOUSBInterfaceUserClientTypeID, kIOCFPlugInInterfaceID, &iPlug, &score) == KERN_SUCCESS && iPlug) {
                    IOUSBInterfaceInterface190 **intf = NULL;
                    (*iPlug)->QueryInterface(iPlug, CFUUIDGetUUIDBytes(kIOUSBInterfaceInterfaceID190), (LPVOID *)&intf);
                    (*iPlug)->Release(iPlug);
                    if (intf) {
                        UInt8 cls = 0, sub = 0, proto = 0;
                        (*intf)->GetInterfaceClass(intf, &cls);
                        (*intf)->GetInterfaceSubClass(intf, &sub);
                        (*intf)->GetInterfaceProtocol(intf, &proto);
                        if ((cls == 6 && sub == 1 && proto == 1) || strcasecmp(intfStr, "MTP") == 0) {
                            strncpy(s->vendor, vendor[0] ? vendor : "MTP Vendor", sizeof(s->vendor) - 1);
                            strncpy(s->product, product[0] ? product : "MTP Device", sizeof(s->product) - 1);
                            strncpy(s->serial, serial[0] ? serial : "MTP-DEFAULT", sizeof(s->serial) - 1);
                            s->vendorId = vid;
                            s->productId = pid;
                            s->locationId = loc;

                            IOReturn kr = (*intf)->USBInterfaceOpen(intf);
                            if (kr != KERN_SUCCESS) {
                                s->busy = true;
                                (*intf)->Release(intf);
                                IOObjectRelease(intfService);
                                IOObjectRelease(intfIter);
                                (*dev)->Release(dev);
                                IOObjectRelease(device);
                                IOObjectRelease(iter);
                                return -2; // Busy / locked
                            }

                            UInt8 numEp = 0;
                            (*intf)->GetNumEndpoints(intf, &numEp);
                            for (UInt8 p = 1; p <= numEp; p++) {
                                UInt8 dir = 0, num = 0, trType = 0, intv = 0; UInt16 maxPkt = 0;
                                (*intf)->GetPipeProperties(intf, p, &dir, &num, &trType, &maxPkt, &intv);
                                if (trType == kUSBBulk) {
                                    if (dir == kUSBIn && !s->pipeIn) s->pipeIn = p;
                                    if (dir == kUSBOut && !s->pipeOut) s->pipeOut = p;
                                }
                            }
                            (*intf)->ClearPipeStallBothEnds(intf, s->pipeIn);
                            (*intf)->ClearPipeStallBothEnds(intf, s->pipeOut);

                            s->dev = dev;
                            s->intf = intf;
                            s->tx = 1;

                            // OpenSession (0x1002)
                            MTPCommand cmd = {0};
                            cmd.length = 16; cmd.type = 1; cmd.code = 0x1002; cmd.transaction_id = s->tx++; cmd.params[0] = 1;
                            (*intf)->WritePipeTO(intf, s->pipeOut, &cmd, 16, 3000, 3000);
                            uint8_t *rbuf = NULL; uint32_t rlen = 0; uint16_t rtype = 0, rcode = 0;
                            if (read_container(s, &rbuf, &rlen, &rtype, &rcode) == 0) {
                                free(rbuf);
                                if (rcode == 0x201E) {
                                    // Session already open: close and reopen cleanly
                                    memset(&cmd, 0, sizeof(cmd));
                                    cmd.length = 12; cmd.type = 1; cmd.code = 0x1003; cmd.transaction_id = s->tx++;
                                    (*intf)->WritePipeTO(intf, s->pipeOut, &cmd, 12, 2000, 2000);
                                    if (read_container(s, &rbuf, &rlen, &rtype, &rcode) == 0) free(rbuf);
                                    memset(&cmd, 0, sizeof(cmd));
                                    cmd.length = 16; cmd.type = 1; cmd.code = 0x1002; cmd.transaction_id = s->tx++; cmd.params[0] = 1;
                                    (*intf)->WritePipeTO(intf, s->pipeOut, &cmd, 16, 3000, 3000);
                                    if (read_container(s, &rbuf, &rlen, &rtype, &rcode) == 0) free(rbuf);
                                }
                            }

                            IOObjectRelease(intfService);
                            IOObjectRelease(intfIter);
                            IOObjectRelease(device);
                            IOObjectRelease(iter);
                            return 0;
                        }
                        (*intf)->Release(intf);
                    }
                }
                IOObjectRelease(intfService);
            }
            IOObjectRelease(intfIter);
        }
        (*dev)->Release(dev);
        IOObjectRelease(device);
    }
    IOObjectRelease(iter);
    return -1;
}

static void close_mtp_session(MTPSession *s) {
    if (!s || !s->intf) return;
    MTPCommand cmd = {0};
    cmd.length = 12; cmd.type = 1; cmd.code = 0x1003; cmd.transaction_id = s->tx++;
    (*s->intf)->WritePipeTO(s->intf, s->pipeOut, &cmd, 12, 2000, 2000);
    uint8_t *rbuf = NULL; uint32_t rlen = 0; uint16_t rtype = 0, rcode = 0;
    if (read_container(s, &rbuf, &rlen, &rtype, &rcode) == 0) free(rbuf);
    (*s->intf)->USBInterfaceClose(s->intf);
    (*s->intf)->Release(s->intf);
    if (s->dev) (*s->dev)->Release(s->dev);
    s->intf = NULL;
    s->dev = NULL;
}

typedef struct {
    uint32_t handle;
    uint16_t format;
    uint32_t size;
    char name[256];
} MTPObjectEntry;

static int list_folder_children(MTPSession *s, uint32_t storageId, uint32_t parentHandle, MTPObjectEntry **out_entries, uint32_t *out_count) {
    *out_entries = NULL;
    *out_count = 0;
    MTPCommand cmd = {0};
    cmd.length = 24; cmd.type = 1; cmd.code = 0x1007; cmd.transaction_id = s->tx++;
    cmd.params[0] = storageId;
    cmd.params[1] = 0;
    cmd.params[2] = parentHandle;
    if ((*s->intf)->WritePipeTO(s->intf, s->pipeOut, &cmd, 24, 4000, 4000) != KERN_SUCCESS) return -1;

    uint8_t *hbuf = NULL; uint32_t hlen = 0; uint16_t htype = 0, hcode = 0;
    uint8_t *rbuf = NULL; uint32_t rlen = 0; uint16_t rtype = 0, rcode = 0;
    if (read_container(s, &hbuf, &hlen, &htype, &hcode) != 0) return -1;
    if (htype != 2) {
        free(hbuf);
        return -1;
    }
    if (read_container(s, &rbuf, &rlen, &rtype, &rcode) == 0) free(rbuf);

    uint32_t n = hlen >= 16 ? *(uint32_t *)(hbuf + 12) : 0;
    if (n == 0) {
        free(hbuf);
        return 0;
    }
    MTPObjectEntry *entries = (MTPObjectEntry *)calloc(n, sizeof(MTPObjectEntry));
    uint32_t valid = 0;
    for (uint32_t i = 0; i < n && (16 + i * 4) < hlen; i++) {
        uint32_t h = *(uint32_t *)(hbuf + 16 + i * 4);
        memset(&cmd, 0, sizeof(cmd));
        cmd.length = 16; cmd.type = 1; cmd.code = 0x1008; cmd.transaction_id = s->tx++;
        cmd.params[0] = h;
        (*s->intf)->WritePipeTO(s->intf, s->pipeOut, &cmd, 16, 4000, 4000);
        uint8_t *ibuf = NULL; uint32_t ilen = 0; uint16_t itype = 0, icode = 0;
        if (read_container(s, &ibuf, &ilen, &itype, &icode) == 0 && itype == 2) {
            if (read_container(s, &rbuf, &rlen, &rtype, &rcode) == 0) free(rbuf);
            if (ilen >= 12 + 52) {
                entries[valid].handle = h;
                entries[valid].format = *(uint16_t *)(ibuf + 12 + 4);
                entries[valid].size = *(uint32_t *)(ibuf + 12 + 8);
                size_t off = 12 + 52;
                read_mtp_string(ibuf, ilen, &off, entries[valid].name, sizeof(entries[valid].name));
                valid++;
            }
            free(ibuf);
        }
    }
    free(hbuf);
    *out_entries = entries;
    *out_count = valid;
    return 0;
}

static uint16_t guess_mtp_format(const char *name, bool isDir) {
    if (isDir) return 0x3001;
    const char *ext = strrchr(name, '.');
    if (!ext) return 0x3000;
    if (strcasecmp(ext, ".mp3") == 0) return 0x3009;
    if (strcasecmp(ext, ".flac") == 0) return 0xB903;
    if (strcasecmp(ext, ".ogg") == 0) return 0xB902;
    if (strcasecmp(ext, ".m4a") == 0 || strcasecmp(ext, ".aac") == 0 || strcasecmp(ext, ".m4b") == 0) return 0xB904;
    if (strcasecmp(ext, ".wav") == 0) return 0x3008;
    if (strcasecmp(ext, ".mp4") == 0 || strcasecmp(ext, ".m4v") == 0) return 0xB982;
    if (strcasecmp(ext, ".m3u") == 0 || strcasecmp(ext, ".m3u8") == 0) return 0xBA05;
    if (strcasecmp(ext, ".jpg") == 0 || strcasecmp(ext, ".jpeg") == 0) return 0x3801;
    if (strcasecmp(ext, ".png") == 0) return 0x380B;
    return 0x3000;
}

static uint32_t create_mtp_folder(MTPSession *s, uint32_t storageId, uint32_t parentHandle, const char *folderName) {
    uint32_t curTx = s->tx++;
    MTPCommand cmd = {0};
    cmd.length = 20; cmd.type = 1; cmd.code = 0x100C; cmd.transaction_id = curTx;
    cmd.params[0] = storageId;
    cmd.params[1] = parentHandle;
    if ((*s->intf)->WritePipeTO(s->intf, s->pipeOut, &cmd, 20, 4000, 4000) != KERN_SUCCESS) return 0;

    uint8_t objInfo[1024] = {0};
    *(uint16_t *)(objInfo + 4) = 2;
    *(uint16_t *)(objInfo + 6) = 0x100C;
    *(uint32_t *)(objInfo + 8) = curTx;
    *(uint32_t *)(objInfo + 12 + 0) = storageId;
    *(uint16_t *)(objInfo + 12 + 4) = 0x3001; // Association (Folder)
    *(uint32_t *)(objInfo + 12 + 38) = parentHandle == 0xFFFFFFFF ? 0 : parentHandle;
    *(uint16_t *)(objInfo + 12 + 42) = 0x0001; // GenericFolder
    size_t off = 12 + 52;
    off += write_mtp_string(objInfo + off, folderName);
    objInfo[off++] = 0;
    objInfo[off++] = 0;
    objInfo[off++] = 0;
    *(uint32_t *)objInfo = (uint32_t)off;

    (*s->intf)->WritePipeTO(s->intf, s->pipeOut, objInfo, (UInt32)off, 4000, 4000);
    uint8_t *rbuf = NULL; uint32_t rlen = 0; uint16_t rtype = 0, rcode = 0;
    uint32_t newHandle = 0;
    if (read_container(s, &rbuf, &rlen, &rtype, &rcode) == 0) {
        if (rcode == 0x2001 && rlen >= 24) {
            newHandle = *(uint32_t *)(rbuf + 20);
        }
        free(rbuf);
    }
    return newHandle;
}

typedef struct {
    uint32_t storageId;
    uint32_t parentHandle;
    char name[256];
    uint32_t handle;
} FolderCacheEntry;

#define MAX_FOLDER_CACHE 1024
static FolderCacheEntry g_folderCache[MAX_FOLDER_CACHE];
static int g_folderCacheCount = 0;

static uint32_t lookup_folder_cache(uint32_t storageId, uint32_t parentHandle, const char *name) {
    for (int i = 0; i < g_folderCacheCount; i++) {
        if (g_folderCache[i].storageId == storageId &&
            g_folderCache[i].parentHandle == parentHandle &&
            strcasecmp(g_folderCache[i].name, name) == 0) {
            return g_folderCache[i].handle;
        }
    }
    return 0;
}

static void insert_folder_cache(uint32_t storageId, uint32_t parentHandle, const char *name, uint32_t handle) {
    if (!handle || g_folderCacheCount >= MAX_FOLDER_CACHE) return;
    g_folderCache[g_folderCacheCount].storageId = storageId;
    g_folderCache[g_folderCacheCount].parentHandle = parentHandle;
    strncpy(g_folderCache[g_folderCacheCount].name, name, sizeof(g_folderCache[0].name) - 1);
    g_folderCache[g_folderCacheCount].handle = handle;
    g_folderCacheCount++;
}

static uint32_t resolve_path(MTPSession *s, uint32_t storageId, const char *remotePath, bool createDirs, bool stopAtParent, char *leafName, size_t leafMax, uint16_t *out_format) {
    char pathCopy[2048];
    strncpy(pathCopy, remotePath, sizeof(pathCopy) - 1);
    pathCopy[sizeof(pathCopy) - 1] = 0;

    char *segments[64];
    int segCount = 0;
    char *saveptr = NULL;
    char *tok = strtok_r(pathCopy, "/", &saveptr);
    while (tok && segCount < 64) {
        if (tok[0] != 0 && strcmp(tok, ".") != 0) {
            segments[segCount++] = tok;
        }
        tok = strtok_r(NULL, "/", &saveptr);
    }

    if (segCount == 0) {
        if (leafName && leafMax > 0) leafName[0] = 0;
        if (out_format) *out_format = 0x3001;
        return 0xFFFFFFFF;
    }

    if (leafName && leafMax > 0) {
        strncpy(leafName, segments[segCount - 1], leafMax - 1);
        leafName[leafMax - 1] = 0;
    }

    int limit = stopAtParent ? (segCount - 1) : segCount;
    uint32_t curParent = 0xFFFFFFFF;
    uint16_t curFmt = 0x3001;

    for (int i = 0; i < limit; i++) {
        uint32_t cached = lookup_folder_cache(storageId, curParent, segments[i]);
        if (cached) {
            curParent = cached;
            curFmt = 0x3001;
            continue;
        }

        MTPObjectEntry *entries = NULL;
        uint32_t count = 0;
        if (list_folder_children(s, storageId, curParent, &entries, &count) != 0) {
            return 0;
        }
        uint32_t foundHandle = 0;
        uint16_t foundFmt = 0;
        for (uint32_t j = 0; j < count; j++) {
            if (entries[j].format == 0x3001) {
                insert_folder_cache(storageId, curParent, entries[j].name, entries[j].handle);
            }
            if (strcasecmp(entries[j].name, segments[i]) == 0) {
                foundHandle = entries[j].handle;
                foundFmt = entries[j].format;
            }
        }
        free(entries);

        if (!foundHandle) {
            if (createDirs) {
                foundHandle = create_mtp_folder(s, storageId, curParent, segments[i]);
                foundFmt = 0x3001;
                if (foundHandle) {
                    insert_folder_cache(storageId, curParent, segments[i], foundHandle);
                }
            }
            if (!foundHandle) return 0;
        }
        curParent = foundHandle;
        curFmt = foundFmt;
    }

    if (out_format) *out_format = curFmt;
    return curParent;
}

static int upload_file_to_mtp(MTPSession *s, uint32_t storageId, const char *localPath, const char *remotePath) {
    struct stat st;
    if (stat(localPath, &st) != 0) return -1;
    uint64_t fileSize = (uint64_t)st.st_size;

    char leafName[256] = {0};
    uint32_t parentHandle = resolve_path(s, storageId, remotePath, true, true, leafName, sizeof(leafName), NULL);
    if (!parentHandle || !leafName[0]) return -1;

    // Never upload macOS hidden metadata files
    if ( strcmp(leafName, ".DS_Store") == 0 || strncmp(leafName, "._", 2) == 0 ) {
        return 0;
    }

    // Check if file already exists in parentHandle; if so, delete it first
    MTPObjectEntry *entries = NULL;
    uint32_t count = 0;
    if (list_folder_children(s, storageId, parentHandle, &entries, &count) == 0) {
        for (uint32_t i = 0; i < count; i++) {
            if (strcasecmp(entries[i].name, leafName) == 0 && entries[i].format != 0x3001) {
                MTPCommand delCmd = {0};
                delCmd.length = 16; delCmd.type = 1; delCmd.code = 0x100B; delCmd.transaction_id = s->tx++;
                delCmd.params[0] = entries[i].handle;
                (*s->intf)->WritePipeTO(s->intf, s->pipeOut, &delCmd, 16, 4000, 4000);
                uint8_t *rbuf = NULL; uint32_t rlen = 0; uint16_t rtype = 0, rcode = 0;
                if (read_container(s, &rbuf, &rlen, &rtype, &rcode) == 0) free(rbuf);
            }
        }
        free(entries);
    }

    // SendObjectInfo (0x100C)
    uint32_t curTx = s->tx++;
    MTPCommand cmd = {0};
    cmd.length = 20; cmd.type = 1; cmd.code = 0x100C; cmd.transaction_id = curTx;
    cmd.params[0] = storageId;
    cmd.params[1] = parentHandle;
    if ((*s->intf)->WritePipeTO(s->intf, s->pipeOut, &cmd, 20, 4000, 4000) != KERN_SUCCESS) return -1;

    uint8_t objInfo[1024] = {0};
    *(uint16_t *)(objInfo + 4) = 2;
    *(uint16_t *)(objInfo + 6) = 0x100C;
    *(uint32_t *)(objInfo + 8) = curTx;
    *(uint32_t *)(objInfo + 12 + 0) = storageId;
    *(uint16_t *)(objInfo + 12 + 4) = guess_mtp_format(leafName, false);
    *(uint32_t *)(objInfo + 12 + 8) = fileSize > 0xFFFFFFFFULL ? 0xFFFFFFFFU : (uint32_t)fileSize;
    *(uint32_t *)(objInfo + 12 + 38) = parentHandle == 0xFFFFFFFF ? 0 : parentHandle;
    size_t off = 12 + 52;
    off += write_mtp_string(objInfo + off, leafName);
    objInfo[off++] = 0;
    objInfo[off++] = 0;
    objInfo[off++] = 0;
    *(uint32_t *)objInfo = (uint32_t)off;

    if ((*s->intf)->WritePipeTO(s->intf, s->pipeOut, objInfo, (UInt32)off, 4000, 4000) != KERN_SUCCESS) return -1;
    uint8_t *rbuf = NULL; uint32_t rlen = 0; uint16_t rtype = 0, rcode = 0;
    if (read_container(s, &rbuf, &rlen, &rtype, &rcode) != 0) return -1;
    free(rbuf);
    if (rcode != 0x2001) return -1;

    // SendObject (0x100D)
    curTx = s->tx++;
    memset(&cmd, 0, sizeof(cmd));
    cmd.length = 12; cmd.type = 1; cmd.code = 0x100D; cmd.transaction_id = curTx;
    if ((*s->intf)->WritePipeTO(s->intf, s->pipeOut, &cmd, 12, 4000, 4000) != KERN_SUCCESS) return -1;

    FILE *fp = fopen(localPath, "rb");
    if (!fp) return -1;

    size_t chunkCap = 65536;
    uint8_t *chunkBuf = (uint8_t *)malloc(chunkCap);
    uint64_t totalContainerLen = 12ULL + fileSize;
    *(uint32_t *)(chunkBuf + 0) = totalContainerLen > 0xFFFFFFFFULL ? 0xFFFFFFFFU : (uint32_t)totalContainerLen;
    *(uint16_t *)(chunkBuf + 4) = 2;
    *(uint16_t *)(chunkBuf + 6) = 0x100D;
    *(uint32_t *)(chunkBuf + 8) = curTx;

    size_t firstRead = fread(chunkBuf + 12, 1, chunkCap - 12, fp);
    if ((*s->intf)->WritePipeTO(s->intf, s->pipeOut, chunkBuf, (UInt32)(12 + firstRead), 10000, 10000) != KERN_SUCCESS) {
        free(chunkBuf);
        fclose(fp);
        return -1;
    }

    while (!feof(fp)) {
        size_t nread = fread(chunkBuf, 1, chunkCap, fp);
        if (nread == 0) break;
        if ((*s->intf)->WritePipeTO(s->intf, s->pipeOut, chunkBuf, (UInt32)nread, 10000, 10000) != KERN_SUCCESS) {
            free(chunkBuf);
            fclose(fp);
            return -1;
        }
    }
    free(chunkBuf);
    fclose(fp);

    if (read_container(s, &rbuf, &rlen, &rtype, &rcode) != 0) return -1;
    free(rbuf);
    return rcode == 0x2001 ? 0 : -1;
}

static int download_file_from_mtp(MTPSession *s, uint32_t storageId, const char *remotePath, const char *localPath) {
    uint16_t fmt = 0;
    uint32_t handle = resolve_path(s, storageId, remotePath, false, false, NULL, 0, &fmt);
    if (!handle || handle == 0xFFFFFFFF || fmt == 0x3001) return -1;

    MTPCommand cmd = {0};
    cmd.length = 16; cmd.type = 1; cmd.code = 0x1009; cmd.transaction_id = s->tx++;
    cmd.params[0] = handle;
    if ((*s->intf)->WritePipeTO(s->intf, s->pipeOut, &cmd, 16, 4000, 4000) != KERN_SUCCESS) return -1;

    uint8_t *dbuf = NULL; uint32_t dlen = 0; uint16_t dtype = 0, dcode = 0;
    uint8_t *rbuf = NULL; uint32_t rlen = 0; uint16_t rtype = 0, rcode = 0;
    if (read_container(s, &dbuf, &dlen, &dtype, &dcode) != 0 || dtype != 2) {
        if (dbuf) free(dbuf);
        return -1;
    }
    if (read_container(s, &rbuf, &rlen, &rtype, &rcode) == 0) free(rbuf);

    FILE *fp = fopen(localPath, "wb");
    if (!fp) {
        free(dbuf);
        return -1;
    }
    if (dlen > 12) {
        fwrite(dbuf + 12, 1, dlen - 12, fp);
    }
    fclose(fp);
    free(dbuf);
    return 0;
}

int main(int argc, char **argv) {
    if (argc < 2) {
        printf("{\"ok\":false,\"error\":\"Usage: rtunes-mtp <detect|ls|get|put|mkdir|rm|rename>\"}\n");
        return 1;
    }

    const char *action = argv[1];

    if (strcmp(action, "usb-poll") == 0) {
        CFMutableDictionaryRef matchingDict = IOServiceMatching(kIOUSBDeviceClassName);
        io_iterator_t iter;
        if (IOServiceGetMatchingServices(kIOMainPortDefault, matchingDict, &iter) != KERN_SUCCESS) {
            printf("{\"ok\":true,\"connected\":false}\n");
            return 0;
        }
        io_service_t device;
        while ((device = IOIteratorNext(iter))) {
            char vendor[128] = {0}, product[128] = {0}, serial[128] = {0};
            get_io_string_prop(device, CFSTR("USB Vendor Name"), vendor, sizeof(vendor));
            if (!vendor[0]) get_io_string_prop(device, CFSTR("kUSBVendorString"), vendor, sizeof(vendor));
            get_io_string_prop(device, CFSTR("USB Product Name"), product, sizeof(product));
            if (!product[0]) get_io_string_prop(device, CFSTR("kUSBProductString"), product, sizeof(product));
            get_io_string_prop(device, CFSTR("kUSBSerialNumberString"), serial, sizeof(serial));
            if (!serial[0]) get_io_string_prop(device, CFSTR("USB Serial Number"), serial, sizeof(serial));
            int vid = get_io_int_prop(device, CFSTR("idVendor"));
            int pid = get_io_int_prop(device, CFSTR("idProduct"));

            io_iterator_t childIter;
            if (IORegistryEntryGetChildIterator(device, kIOServicePlane, &childIter) == KERN_SUCCESS) {
                io_service_t child;
                while ((child = IOIteratorNext(childIter))) {
                    char kstr[64] = {0};
                    get_io_string_prop(child, CFSTR("kUSBString"), kstr, sizeof(kstr));
                    int icls = get_io_int_prop(child, CFSTR("bInterfaceClass"));
                    int isub = get_io_int_prop(child, CFSTR("bInterfaceSubClass"));
                    int ipro = get_io_int_prop(child, CFSTR("bInterfaceProtocol"));
                    if ((icls == 6 && isub == 1 && ipro == 1) || strcasecmp(kstr, "MTP") == 0) {
                        char vEsc[256], pEsc[256], sEsc[256];
                        json_escape(vendor[0] ? vendor : "MTP Vendor", vEsc, sizeof(vEsc));
                        json_escape(product[0] ? product : "MTP Device", pEsc, sizeof(pEsc));
                        json_escape(serial[0] ? serial : "MTP-DEFAULT", sEsc, sizeof(sEsc));
                        printf("{\"ok\":true,\"connected\":true,\"vendor\":\"%s\",\"product\":\"%s\",\"serial\":\"%s\",\"vendorId\":%d,\"productId\":%d}\n",
                               vEsc, pEsc, sEsc, vid, pid);
                        IOObjectRelease(child);
                        IOObjectRelease(childIter);
                        IOObjectRelease(device);
                        IOObjectRelease(iter);
                        return 0;
                    }
                    IOObjectRelease(child);
                }
                IOObjectRelease(childIter);
            }
            IOObjectRelease(device);
        }
        IOObjectRelease(iter);
        printf("{\"ok\":true,\"connected\":false}\n");
        return 0;
    }

    MTPSession s;
    int openRes = open_mtp_session(&s);

    if (strcmp(action, "detect") == 0) {
        if (openRes == -1) {
            printf("{\"ok\":true,\"connected\":false,\"busy\":false,\"devices\":[]}\n");
            return 0;
        }
        if (openRes == -2) {
            char vEsc[256], pEsc[256], sEsc[256];
            json_escape(s.vendor, vEsc, sizeof(vEsc));
            json_escape(s.product, pEsc, sizeof(pEsc));
            json_escape(s.serial, sEsc, sizeof(sEsc));
            printf("{\"ok\":true,\"connected\":true,\"busy\":true,\"vendor\":\"%s\",\"product\":\"%s\",\"serial\":\"%s\",\"vendorId\":%d,\"productId\":%d,\"error\":\"USB MTP interface is locked by another application (such as OpenMTP or Android File Transfer). Please quit conflicting MTP apps.\"}\n",
                   vEsc, pEsc, sEsc, s.vendorId, s.productId);
            return 0;
        }

        // Query Friendly Name (0x1014 GetDevicePropValue for 0xD402)
        char friendlyName[128] = {0};
        MTPCommand cmd = {0};
        cmd.length = 16; cmd.type = 1; cmd.code = 0x1014; cmd.transaction_id = s.tx++; cmd.params[0] = 0xD402;
        (*s.intf)->WritePipeTO(s.intf, s.pipeOut, &cmd, 16, 2000, 2000);
        uint8_t *pbuf = NULL; uint32_t plen = 0; uint16_t ptype = 0, pcode = 0;
        uint8_t *rbuf = NULL; uint32_t rlen = 0; uint16_t rtype = 0, rcode = 0;
        if (read_container(&s, &pbuf, &plen, &ptype, &pcode) == 0) {
            if (ptype == 2 && plen > 12) {
                size_t off = 12;
                read_mtp_string(pbuf, plen, &off, friendlyName, sizeof(friendlyName));
                for (size_t k = 0; friendlyName[k]; k++) {
                    if ((unsigned char)friendlyName[k] < 32 || (unsigned char)friendlyName[k] >= 127) {
                        friendlyName[0] = 0;
                        break;
                    }
                }
                if (read_container(&s, &rbuf, &rlen, &rtype, &rcode) == 0) free(rbuf);
            }
            free(pbuf);
        }

        // GetStorageIDs (0x1004)
        memset(&cmd, 0, sizeof(cmd));
        cmd.length = 12; cmd.type = 1; cmd.code = 0x1004; cmd.transaction_id = s.tx++;
        (*s.intf)->WritePipeTO(s.intf, s.pipeOut, &cmd, 12, 3000, 3000);
        uint8_t *sbuf = NULL; uint32_t slen = 0; uint16_t stype = 0, scode = 0;
        uint32_t sids[16] = {0};
        uint32_t scount = 0;
        if (read_container(&s, &sbuf, &slen, &stype, &scode) == 0 && stype == 2) {
            if (read_container(&s, &rbuf, &rlen, &rtype, &rcode) == 0) free(rbuf);
            if (slen >= 16) {
                scount = *(uint32_t *)(sbuf + 12);
                if (scount > 16) scount = 16;
                for (uint32_t i = 0; i < scount; i++) {
                    sids[i] = *(uint32_t *)(sbuf + 16 + i * 4);
                }
            }
            free(sbuf);
        }

        char vEsc[256], pEsc[256], sEsc[256], fEsc[256];
        json_escape(s.vendor, vEsc, sizeof(vEsc));
        json_escape(s.product, pEsc, sizeof(pEsc));
        json_escape(s.serial, sEsc, sizeof(sEsc));
        json_escape(friendlyName[0] ? friendlyName : s.product, fEsc, sizeof(fEsc));

        printf("{\"ok\":true,\"connected\":true,\"busy\":false,\"vendor\":\"%s\",\"product\":\"%s\",\"friendlyName\":\"%s\",\"serial\":\"%s\",\"vendorId\":%d,\"productId\":%d,\"storages\":[",
               vEsc, pEsc, fEsc, sEsc, s.vendorId, s.productId);

        for (uint32_t i = 0; i < scount; i++) {
            uint32_t sid = sids[i];
            memset(&cmd, 0, sizeof(cmd));
            cmd.length = 16; cmd.type = 1; cmd.code = 0x1005; cmd.transaction_id = s.tx++; cmd.params[0] = sid;
            (*s.intf)->WritePipeTO(s.intf, s.pipeOut, &cmd, 16, 3000, 3000);
            uint8_t *ibuf = NULL; uint32_t ilen = 0; uint16_t itype = 0, icode = 0;
            uint64_t maxCap = 0, freeBytes = 0;
            char desc[128] = {0}, vol[128] = {0};
            if (read_container(&s, &ibuf, &ilen, &itype, &icode) == 0 && itype == 2) {
                if (read_container(&s, &rbuf, &rlen, &rtype, &rcode) == 0) free(rbuf);
                if (ilen >= 12 + 26) {
                    maxCap = *(uint64_t *)(ibuf + 12 + 6);
                    freeBytes = *(uint64_t *)(ibuf + 12 + 14);
                    size_t off = 12 + 26;
                    read_mtp_string(ibuf, ilen, &off, desc, sizeof(desc));
                    read_mtp_string(ibuf, ilen, &off, vol, sizeof(vol));
                }
                free(ibuf);
            }

            // Check root for .retrotunes_device.json
            MTPObjectEntry *rootEntries = NULL;
            uint32_t rootCount = 0;
            char manifestEsc[8192] = {0};
            bool hasManifest = false;
            if (list_folder_children(&s, sid, 0xFFFFFFFF, &rootEntries, &rootCount) == 0) {
                for (uint32_t r = 0; r < rootCount; r++) {
                    if (strcmp(rootEntries[r].name, ".retrotunes_device.json") == 0) {
                        memset(&cmd, 0, sizeof(cmd));
                        cmd.length = 16; cmd.type = 1; cmd.code = 0x1009; cmd.transaction_id = s.tx++; cmd.params[0] = rootEntries[r].handle;
                        (*s.intf)->WritePipeTO(s.intf, s.pipeOut, &cmd, 16, 3000, 3000);
                        uint8_t *mbuf = NULL; uint32_t mlen = 0; uint16_t mtype = 0, mcode = 0;
                        if (read_container(&s, &mbuf, &mlen, &mtype, &mcode) == 0 && mtype == 2) {
                            if (read_container(&s, &rbuf, &rlen, &rtype, &rcode) == 0) free(rbuf);
                            if (mlen > 12) {
                                uint32_t payLen = mlen - 12;
                                char *rawJson = (char *)calloc(payLen + 1, 1);
                                memcpy(rawJson, mbuf + 12, payLen);
                                json_escape(rawJson, manifestEsc, sizeof(manifestEsc));
                                hasManifest = true;
                                free(rawJson);
                            }
                            free(mbuf);
                        }
                    }
                }
                free(rootEntries);
            }

            char dEsc[256], volEsc[256];
            json_escape(desc[0] ? desc : "Storage", dEsc, sizeof(dEsc));
            json_escape(vol, volEsc, sizeof(volEsc));

            printf("%s{\"storageId\":\"0x%08x\",\"storageIdNum\":%u,\"description\":\"%s\",\"volumeIdentifier\":\"%s\",\"totalBytes\":%llu,\"freeBytes\":%llu,\"hasManifest\":%s,\"manifestJson\":\"%s\"}",
                   i > 0 ? "," : "", sid, sid, dEsc, volEsc, maxCap, freeBytes, hasManifest ? "true" : "false", manifestEsc);
        }
        printf("]}\n");
        close_mtp_session(&s);
        return 0;
    }

    if (openRes != 0) {
        printf("{\"ok\":false,\"busy\":%s,\"error\":\"MTP device not available or interface locked\"}\n", openRes == -2 ? "true" : "false");
        return 1;
    }

    if (strcmp(action, "ls") == 0 && argc >= 4) {
        uint32_t sid = (uint32_t)strtoul(argv[2], NULL, 0);
        const char *remotePath = argv[3];
        uint16_t fmt = 0;
        uint32_t folderHandle = resolve_path(&s, sid, remotePath, false, false, NULL, 0, &fmt);
        if (!folderHandle) {
            printf("{\"ok\":true,\"entries\":[]}\n");
            close_mtp_session(&s);
            return 0;
        }
        MTPObjectEntry *entries = NULL;
        uint32_t count = 0;
        list_folder_children(&s, sid, folderHandle, &entries, &count);
        printf("{\"ok\":true,\"entries\":[");
        for (uint32_t i = 0; i < count; i++) {
            char nEsc[512];
            json_escape(entries[i].name, nEsc, sizeof(nEsc));
            printf("%s{\"handle\":%u,\"name\":\"%s\",\"isDir\":%s,\"size\":%u}",
                   i > 0 ? "," : "", entries[i].handle, nEsc, entries[i].format == 0x3001 ? "true" : "false", entries[i].size);
        }
        printf("]}\n");
        free(entries);
        close_mtp_session(&s);
        return 0;
    }

    if (strcmp(action, "get") == 0 && argc >= 5) {
        uint32_t sid = (uint32_t)strtoul(argv[2], NULL, 0);
        int rc = download_file_from_mtp(&s, sid, argv[3], argv[4]);
        close_mtp_session(&s);
        printf("{\"ok\":%s}\n", rc == 0 ? "true" : "false");
        return rc == 0 ? 0 : 1;
    }

    if (strcmp(action, "put") == 0 && argc >= 5) {
        uint32_t sid = (uint32_t)strtoul(argv[2], NULL, 0);
        int rc = upload_file_to_mtp(&s, sid, argv[3], argv[4]);
        close_mtp_session(&s);
        printf("{\"ok\":%s}\n", rc == 0 ? "true" : "false");
        return rc == 0 ? 0 : 1;
    }

    if (strcmp(action, "mkdir") == 0 && argc >= 4) {
        uint32_t sid = (uint32_t)strtoul(argv[2], NULL, 0);
        uint32_t h = resolve_path(&s, sid, argv[3], true, false, NULL, 0, NULL);
        close_mtp_session(&s);
        printf("{\"ok\":%s,\"handle\":%u}\n", h != 0 ? "true" : "false", h);
        return h != 0 ? 0 : 1;
    }

    if (strcmp(action, "rm") == 0 && argc >= 4) {
        uint32_t sid = (uint32_t)strtoul(argv[2], NULL, 0);
        uint32_t h = resolve_path(&s, sid, argv[3], false, false, NULL, 0, NULL);
        bool ok = false;
        if (h && h != 0xFFFFFFFF) {
            MTPCommand cmd = {0};
            cmd.length = 16; cmd.type = 1; cmd.code = 0x100B; cmd.transaction_id = s.tx++;
            cmd.params[0] = h;
            (*s.intf)->WritePipeTO(s.intf, s.pipeOut, &cmd, 16, 4000, 4000);
            uint8_t *rbuf = NULL; uint32_t rlen = 0; uint16_t rtype = 0, rcode = 0;
            if (read_container(&s, &rbuf, &rlen, &rtype, &rcode) == 0) {
                ok = (rcode == 0x2001);
                free(rbuf);
            }
        }
        close_mtp_session(&s);
        printf("{\"ok\":%s}\n", ok ? "true" : "false");
        return ok ? 0 : 1;
    }

    if (strcmp(action, "rename") == 0 && argc >= 3) {
        const char *newName = argv[2];
        uint32_t curTx = s.tx++;
        MTPCommand cmd = {0};
        cmd.length = 16; cmd.type = 1; cmd.code = 0x1016; cmd.transaction_id = curTx;
        cmd.params[0] = 0xD402;
        (*s.intf)->WritePipeTO(s.intf, s.pipeOut, &cmd, 16, 3000, 3000);
        uint8_t propData[512] = {0};
        *(uint16_t *)(propData + 4) = 2;
        *(uint16_t *)(propData + 6) = 0x1016;
        *(uint32_t *)(propData + 8) = curTx;
        size_t off = 12 + write_mtp_string(propData + 12, newName);
        *(uint32_t *)propData = (uint32_t)off;
        (*s.intf)->WritePipeTO(s.intf, s.pipeOut, propData, (UInt32)off, 3000, 3000);
        uint8_t *rbuf = NULL; uint32_t rlen = 0; uint16_t rtype = 0, rcode = 0;
        bool ok = false;
        if (read_container(&s, &rbuf, &rlen, &rtype, &rcode) == 0) {
            ok = (rcode == 0x2001);
            free(rbuf);
        }
        close_mtp_session(&s);
        printf("{\"ok\":%s}\n", ok ? "true" : "false");
        return 0;
    }

    if (strcmp(action, "batch-put") == 0 && argc >= 4) {
        uint32_t sid = (uint32_t)strtoul(argv[2], NULL, 0);
        const char *listFile = argv[3];
        FILE *fp = fopen(listFile, "r");
        if (!fp) {
            close_mtp_session(&s);
            printf("{\"ok\":false,\"error\":\"Cannot open batch file\"}\n");
            return 1;
        }
        char line[4096];
        int uploaded = 0, failed = 0;
        while (fgets(line, sizeof(line), fp)) {
            size_t len = strlen(line);
            while (len > 0 && (line[len - 1] == '\n' || line[len - 1] == '\r')) line[--len] = 0;
            char *tab = strchr(line, '\t');
            if (!tab) continue;
            *tab = 0;
            const char *localPath = line;
            const char *remotePath = tab + 1;
            if (upload_file_to_mtp(&s, sid, localPath, remotePath) == 0) {
                uploaded++;
                fprintf(stderr, "PROGRESS\t%d\t%s\n", uploaded, remotePath);
            } else {
                failed++;
            }
        }
        fclose(fp);
        close_mtp_session(&s);
        printf("{\"ok\":true,\"uploaded\":%d,\"failed\":%d}\n", uploaded, failed);
        return 0;
    }

    close_mtp_session(&s);
    printf("{\"ok\":false,\"error\":\"Unknown command\"}\n");
    return 1;
}

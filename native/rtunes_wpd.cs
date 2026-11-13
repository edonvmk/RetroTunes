using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using PortableDeviceApiLib;
using PortableDeviceTypesLib;
using ApiKey = PortableDeviceApiLib._tagpropertykey;
using TypesKey = PortableDeviceTypesLib._tagpropertykey;
using ApiPropVariant = PortableDeviceApiLib.tag_inner_PROPVARIANT;

namespace RetroTunesWpd {
    static class WpdKeys {
        public static ApiKey MakeApiKey(string guid, uint pid) {
            return new ApiKey { fmtid = new Guid(guid), pid = pid };
        }
        public static TypesKey MakeTypesKey(string guid, uint pid) {
            return new TypesKey { fmtid = new Guid(guid), pid = pid };
        }

        public static ApiKey WPD_OBJECT_PARENT_ID = MakeApiKey("EF6B490D-5CD8-437A-AFFC-DA8B60EE4A3C", 3);
        public static ApiKey WPD_OBJECT_NAME = MakeApiKey("EF6B490D-5CD8-437A-AFFC-DA8B60EE4A3C", 4);
        public static ApiKey WPD_OBJECT_CONTENT_TYPE = MakeApiKey("EF6B490D-5CD8-437A-AFFC-DA8B60EE4A3C", 7);
        public static ApiKey WPD_OBJECT_SIZE = MakeApiKey("EF6B490D-5CD8-437A-AFFC-DA8B60EE4A3C", 11);
        public static ApiKey WPD_OBJECT_ORIGINAL_FILE_NAME = MakeApiKey("EF6B490D-5CD8-437A-AFFC-DA8B60EE4A3C", 12);

        public static ApiKey WPD_STORAGE_CAPACITY = MakeApiKey("01A3057A-74D6-4E80-BEA7-DC4C212CE50A", 4);
        public static ApiKey WPD_STORAGE_FREE_SPACE_IN_BYTES = MakeApiKey("01A3057A-74D6-4E80-BEA7-DC4C212CE50A", 5);
        public static ApiKey WPD_STORAGE_DESCRIPTION = MakeApiKey("01A3057A-74D6-4E80-BEA7-DC4C212CE50A", 8);

        public static ApiKey WPD_RESOURCE_DEFAULT = MakeApiKey("E81E79BE-34F0-41BF-B53F-F1A06AE87842", 0);

        public static ApiKey WPD_CLIENT_NAME = MakeApiKey("204D9F0C-2292-4080-9F42-40664E70F859", 2);
        public static ApiKey WPD_CLIENT_MAJOR_VERSION = MakeApiKey("204D9F0C-2292-4080-9F42-40664E70F859", 3);
        public static ApiKey WPD_CLIENT_MINOR_VERSION = MakeApiKey("204D9F0C-2292-4080-9F42-40664E70F859", 4);
        public static ApiKey WPD_CLIENT_REVISION = MakeApiKey("204D9F0C-2292-4080-9F42-40664E70F859", 5);

        public static Guid WPD_CONTENT_TYPE_FUNCTIONAL_OBJECT = new Guid("99ED0160-17FF-4C44-9D98-1D7A6F941921");
        public static Guid WPD_CONTENT_TYPE_FOLDER = new Guid("27E2E392-A111-48E0-AB0C-E17705A05F85");
        public static Guid WPD_CONTENT_TYPE_AUDIO = new Guid("4AD2C85E-5E2D-45E5-8864-4F229E3C6CF0");
        public static Guid WPD_CONTENT_TYPE_VIDEO = new Guid("9261B03C-3D78-4519-85E3-02C5E1F50BB9");
        public static Guid WPD_CONTENT_TYPE_IMAGE = new Guid("EF2107D5-A52A-4943-A2EC-2984F8D4AB65");
        public static Guid WPD_CONTENT_TYPE_GENERIC_FILE = new Guid("0085E0A6-8D34-45D7-BC5C-447E59C73D48");
    }

    [ComImport, Guid("a1567595-4c2f-4574-a6fa-ecef917b9a40"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMgrRaw {
        void GetDevices([In, Out, MarshalAs(UnmanagedType.LPArray, ArraySubType = UnmanagedType.LPWStr)] string[] pPnPDeviceIDs, ref uint pcPnPDeviceIDs);
        void RefreshDeviceList();
        void GetDeviceFriendlyName([MarshalAs(UnmanagedType.LPWStr)] string pszPnPDeviceID, [MarshalAs(UnmanagedType.LPWStr)] StringBuilder pDeviceFriendlyName, ref uint pcchDeviceFriendlyName);
        void GetDeviceDescription([MarshalAs(UnmanagedType.LPWStr)] string pszPnPDeviceID, [MarshalAs(UnmanagedType.LPWStr)] StringBuilder pDeviceDescription, ref uint pcchDeviceDescription);
        void GetDeviceManufacturer([MarshalAs(UnmanagedType.LPWStr)] string pszPnPDeviceID, [MarshalAs(UnmanagedType.LPWStr)] StringBuilder pDeviceManufacturer, ref uint pcchDeviceManufacturer);
    }

    class WpdSession : IDisposable {
        public PortableDeviceApiLib.IPortableDevice Device;
        public PortableDeviceApiLib.IPortableDeviceContent Content;
        public PortableDeviceApiLib.IPortableDeviceProperties Props;
        public PortableDeviceApiLib.IPortableDeviceResources Resources;
        public string PnpId;
        public string FriendlyName;
        public string Manufacturer;
        public string Serial;

        public static List<string> GetMtpDeviceIds(IMgrRaw mgr) {
            var res = new List<string>();
            uint count = 0;
            mgr.GetDevices(null, ref count);
            if (count == 0) return res;
            var ids = new string[count];
            mgr.GetDevices(ids, ref count);
            foreach (var id in ids) {
                if (string.IsNullOrEmpty(id)) continue;
                if (id.IndexOf("wpdbusenum", StringComparison.OrdinalIgnoreCase) >= 0) continue;
                if (id.IndexOf("usbstor", StringComparison.OrdinalIgnoreCase) >= 0) continue;
                res.Add(id);
            }
            return res;
        }

        public static WpdSession OpenFirst(string preferredSerial = null) {
            var mgr = (IMgrRaw)new PortableDeviceManagerClass();
            var ids = GetMtpDeviceIds(mgr);
            if (ids.Count == 0) return null;

            string chosenId = ids[0];
            if (!string.IsNullOrEmpty(preferredSerial)) {
                foreach (var id in ids) {
                    if (id.IndexOf(preferredSerial, StringComparison.OrdinalIgnoreCase) >= 0) {
                        chosenId = id;
                        break;
                    }
                }
            }

            var session = new WpdSession();
            session.PnpId = chosenId;
            session.FriendlyName = GetMgrStr(mgr.GetDeviceFriendlyName, chosenId);
            session.Manufacturer = GetMgrStr(mgr.GetDeviceManufacturer, chosenId);
            if (string.IsNullOrEmpty(session.FriendlyName)) {
                session.FriendlyName = GetMgrStr(mgr.GetDeviceDescription, chosenId);
            }
            session.Serial = ExtractSerial(chosenId);

            var clientInfo = (PortableDeviceApiLib.IPortableDeviceValues)new PortableDeviceValuesClass();
            clientInfo.SetStringValue(ref WpdKeys.WPD_CLIENT_NAME, "RetroTunes");
            clientInfo.SetUnsignedIntegerValue(ref WpdKeys.WPD_CLIENT_MAJOR_VERSION, 1);
            clientInfo.SetUnsignedIntegerValue(ref WpdKeys.WPD_CLIENT_MINOR_VERSION, 0);
            clientInfo.SetUnsignedIntegerValue(ref WpdKeys.WPD_CLIENT_REVISION, 0);

            session.Device = (PortableDeviceApiLib.IPortableDevice)new PortableDeviceFTMClass();
            session.Device.Open(chosenId, clientInfo);
            session.Device.Content(out session.Content);
            session.Content.Properties(out session.Props);
            session.Content.Transfer(out session.Resources);
            return session;
        }

        delegate void MgrStrHelper(string id, StringBuilder sb, ref uint len);
        static string GetMgrStr(MgrStrHelper fn, string id) {
            try {
                uint len = 0;
                fn(id, null, ref len);
                if (len == 0) return "";
                var sb = new StringBuilder((int)len + 1);
                fn(id, sb, ref len);
                return sb.ToString();
            } catch { return ""; }
        }

        public static string ExtractSerial(string pnpId) {
            if (string.IsNullOrEmpty(pnpId)) return "MTP-WIN32";
            var parts = pnpId.Split('#');
            if (parts.Length >= 3 && !string.IsNullOrWhiteSpace(parts[2])) {
                return parts[2].ToUpperInvariant();
            }
            return pnpId;
        }

        public List<string> EnumChildIds(string parentId) {
            var res = new List<string>();
            IEnumPortableDeviceObjectIDs enumerator;
            Content.EnumObjects(0, parentId, null, out enumerator);
            if (enumerator == null) return res;
            while (true) {
                string objId = null;
                uint fetched = 0;
                enumerator.Next(1, out objId, ref fetched);
                if (fetched == 0 || objId == null) break;
                res.Add(objId);
            }
            return res;
        }

        public string GetStringProp(string objId, ApiKey key) {
            try {
                var keys = (PortableDeviceApiLib.IPortableDeviceKeyCollection)new PortableDeviceKeyCollectionClass();
                keys.Add(ref key);
                PortableDeviceApiLib.IPortableDeviceValues vals;
                Props.GetValues(objId, keys, out vals);
                string s;
                vals.GetStringValue(ref key, out s);
                return s ?? "";
            } catch { return ""; }
        }

        public ulong GetUlongProp(string objId, ApiKey key) {
            try {
                var keys = (PortableDeviceApiLib.IPortableDeviceKeyCollection)new PortableDeviceKeyCollectionClass();
                keys.Add(ref key);
                PortableDeviceApiLib.IPortableDeviceValues vals;
                Props.GetValues(objId, keys, out vals);
                ulong v;
                vals.GetUnsignedLargeIntegerValue(ref key, out v);
                return v;
            } catch { return 0; }
        }

        public Guid GetGuidProp(string objId, ApiKey key) {
            try {
                var keys = (PortableDeviceApiLib.IPortableDeviceKeyCollection)new PortableDeviceKeyCollectionClass();
                keys.Add(ref key);
                PortableDeviceApiLib.IPortableDeviceValues vals;
                Props.GetValues(objId, keys, out vals);
                Guid g;
                vals.GetGuidValue(ref key, out g);
                return g;
            } catch { return Guid.Empty; }
        }

        public string GetName(string objId) {
            string n = GetStringProp(objId, WpdKeys.WPD_OBJECT_ORIGINAL_FILE_NAME);
            if (!string.IsNullOrEmpty(n)) return n;
            return GetStringProp(objId, WpdKeys.WPD_OBJECT_NAME);
        }

        public bool IsDir(string objId) {
            var g = GetGuidProp(objId, WpdKeys.WPD_OBJECT_CONTENT_TYPE);
            return g == WpdKeys.WPD_CONTENT_TYPE_FOLDER || g == WpdKeys.WPD_CONTENT_TYPE_FUNCTIONAL_OBJECT;
        }

        public string FindChildByName(string parentId, string name) {
            foreach (var cid in EnumChildIds(parentId)) {
                if (string.Equals(GetName(cid), name, StringComparison.OrdinalIgnoreCase)) {
                    return cid;
                }
            }
            return null;
        }

        public string ResolvePath(string storageId, string remotePath) {
            string clean = (remotePath ?? "").Replace('\\', '/').Trim('/');
            if (string.IsNullOrEmpty(clean)) return storageId;
            string cur = storageId;
            foreach (var seg in clean.Split('/')) {
                if (string.IsNullOrEmpty(seg)) continue;
                cur = FindChildByName(cur, seg);
                if (cur == null) return null;
            }
            return cur;
        }

        public string EnsureDir(string storageId, string remoteDir) {
            string clean = (remoteDir ?? "").Replace('\\', '/').Trim('/');
            if (string.IsNullOrEmpty(clean)) return storageId;
            string cur = storageId;
            foreach (var seg in clean.Split('/')) {
                if (string.IsNullOrEmpty(seg)) continue;
                string next = FindChildByName(cur, seg);
                if (next == null) {
                    var vals = (PortableDeviceApiLib.IPortableDeviceValues)new PortableDeviceValuesClass();
                    vals.SetStringValue(ref WpdKeys.WPD_OBJECT_PARENT_ID, cur);
                    vals.SetStringValue(ref WpdKeys.WPD_OBJECT_NAME, seg);
                    var folderGuid = WpdKeys.WPD_CONTENT_TYPE_FOLDER;
                    vals.SetGuidValue(ref WpdKeys.WPD_OBJECT_CONTENT_TYPE, ref folderGuid);
                    Content.CreateObjectWithPropertiesOnly(vals, ref next);
                }
                cur = next;
            }
            return cur;
        }

        public bool GetFile(string storageId, string remotePath, string localPath) {
            string objId = ResolvePath(storageId, remotePath);
            if (objId == null) return false;
            uint optBuf = 0;
            PortableDeviceApiLib.IStream stream;
            Resources.GetStream(objId, ref WpdKeys.WPD_RESOURCE_DEFAULT, 0, ref optBuf, out stream);
            if (stream == null) return false;
            Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(localPath)));
            uint bufSize = optBuf > 0 ? optBuf : 65536;
            byte[] buf = new byte[bufSize];
            using (var fs = File.Create(localPath)) {
                try {
                    while (true) {
                        uint read = 0;
                        stream.RemoteRead(out buf[0], bufSize, out read);
                        if (read == 0) break;
                        fs.Write(buf, 0, (int)read);
                    }
                } finally {
                    Marshal.ReleaseComObject(stream);
                }
            }
            return true;
        }

        public bool PutFile(string storageId, string localPath, string remotePath) {
            if (!File.Exists(localPath)) return false;
            string norm = (remotePath ?? "").Replace('\\', '/').Trim('/');
            int slash = norm.LastIndexOf('/');
            string dirPart = slash > 0 ? norm.Substring(0, slash) : "";
            string fileName = slash >= 0 ? norm.Substring(slash + 1) : norm;

            string parentId = EnsureDir(storageId, dirPart);
            string existing = FindChildByName(parentId, fileName);
            if (existing != null) {
                try {
                    var delIds = (PortableDeviceApiLib.IPortableDevicePropVariantCollection)new PortableDevicePropVariantCollectionClass();
                    var pv = new ApiPropVariant { vt = 31 };
                    IntPtr ptr = Marshal.StringToCoTaskMemUni(existing);
                    // Note: union offset in tag_inner_PROPVARIANT; fallback to Delete if needed
                    var vals = (PortableDeviceApiLib.IPortableDeviceValues)new PortableDeviceValuesClass();
                    var key = WpdKeys.WPD_OBJECT_PARENT_ID;
                    vals.SetStringValue(ref key, existing);
                    ApiPropVariant pvOut;
                    vals.GetValue(ref key, out pvOut);
                    delIds.Add(ref pvOut);
                    Marshal.FreeCoTaskMem(ptr);
                    PortableDeviceApiLib.IPortableDevicePropVariantCollection results = null;
                    Content.Delete(0, delIds, ref results);
                } catch { }
            }

            var fi = new FileInfo(localPath);
            var props = (PortableDeviceApiLib.IPortableDeviceValues)new PortableDeviceValuesClass();
            props.SetStringValue(ref WpdKeys.WPD_OBJECT_PARENT_ID, parentId);
            props.SetStringValue(ref WpdKeys.WPD_OBJECT_NAME, Path.GetFileNameWithoutExtension(fileName));
            props.SetStringValue(ref WpdKeys.WPD_OBJECT_ORIGINAL_FILE_NAME, fileName);
            props.SetUnsignedLargeIntegerValue(ref WpdKeys.WPD_OBJECT_SIZE, (ulong)fi.Length);
            Guid ctype = GuessContentType(fileName);
            props.SetGuidValue(ref WpdKeys.WPD_OBJECT_CONTENT_TYPE, ref ctype);

            PortableDeviceApiLib.IStream dstStream;
            uint optBuf = 0;
            string cookie = null;
            Content.CreateObjectWithPropertiesAndData(props, out dstStream, ref optBuf, ref cookie);
            uint bufSize = optBuf > 0 ? optBuf : 65536;
            byte[] buf = new byte[bufSize];
            using (var fs = File.OpenRead(localPath)) {
                try {
                    while (true) {
                        int read = fs.Read(buf, 0, buf.Length);
                        if (read <= 0) break;
                        uint written = 0;
                        dstStream.RemoteWrite(ref buf[0], (uint)read, out written);
                    }
                    dstStream.Commit(0);
                } finally {
                    Marshal.ReleaseComObject(dstStream);
                }
            }
            return true;
        }

        static Guid GuessContentType(string fileName) {
            string ext = Path.GetExtension(fileName).ToLowerInvariant();
            if (ext == ".mp3" || ext == ".flac" || ext == ".m4a" || ext == ".aac" || ext == ".ogg" || ext == ".wav" || ext == ".opus")
                return WpdKeys.WPD_CONTENT_TYPE_AUDIO;
            if (ext == ".mp4" || ext == ".mkv" || ext == ".avi" || ext == ".mov" || ext == ".m4v")
                return WpdKeys.WPD_CONTENT_TYPE_VIDEO;
            if (ext == ".jpg" || ext == ".jpeg" || ext == ".png" || ext == ".webp" || ext == ".bmp")
                return WpdKeys.WPD_CONTENT_TYPE_IMAGE;
            return WpdKeys.WPD_CONTENT_TYPE_GENERIC_FILE;
        }

        public void Dispose() {
            try { if (Device != null) Device.Close(); } catch { }
        }
    }

    class Program {
        static string JsonEscape(string s) {
            if (s == null) return "null";
            var sb = new StringBuilder(s.Length + 8);
            sb.Append('"');
            foreach (char c in s) {
                switch (c) {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\b': sb.Append("\\b"); break;
                    case '\f': sb.Append("\\f"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < ' ') sb.AppendFormat("\\u{0:x4}", (int)c);
                        else sb.Append(c);
                        break;
                }
            }
            sb.Append('"');
            return sb.ToString();
        }

        [MTAThread]
        static int Main(string[] args) {
            if (args.Length == 0) return 1;
            string cmd = args[0];

            try {
                if (cmd == "usb-poll") {
                    var mgr = (IMgrRaw)new PortableDeviceManagerClass();
                    var ids = WpdSession.GetMtpDeviceIds(mgr);
                    if (ids.Count == 0) {
                        Console.WriteLine("{\"usbAttached\":false}");
                        return 0;
                    }
                    Console.WriteLine("{\"usbAttached\":true,\"serial\":" + JsonEscape(WpdSession.ExtractSerial(ids[0])) + "}");
                    return 0;
                }

                using (var s = WpdSession.OpenFirst()) {
                    if (s == null) {
                        if (cmd == "detect") {
                            Console.WriteLine("{\"connected\":false}");
                            return 0;
                        }
                        Console.Error.WriteLine("No WPD/MTP device connected");
                        return 1;
                    }

                    if (cmd == "detect") {
                        string deviceName = s.GetName("DEVICE");
                        var rootChildren = s.EnumChildIds("DEVICE");
                        var storagesJson = new List<string>();
                        foreach (var objId in rootChildren) {
                            Guid ctype = s.GetGuidProp(objId, WpdKeys.WPD_OBJECT_CONTENT_TYPE);
                            if (ctype != WpdKeys.WPD_CONTENT_TYPE_FUNCTIONAL_OBJECT) continue;
                            ulong maxCap = s.GetUlongProp(objId, WpdKeys.WPD_STORAGE_CAPACITY);
                            if (maxCap == 0) continue;
                            ulong freeSpace = s.GetUlongProp(objId, WpdKeys.WPD_STORAGE_FREE_SPACE_IN_BYTES);
                            string desc = s.GetStringProp(objId, WpdKeys.WPD_STORAGE_DESCRIPTION);
                            if (string.IsNullOrEmpty(desc)) desc = s.GetName(objId);

                            bool hasManifest = false;
                            string manifestJson = null;
                            string manifestId = s.FindChildByName(objId, ".retrotunes_device.json");
                            if (manifestId != null) {
                                string tmp = Path.Combine(Path.GetTempPath(), "rtunes_manifest_" + Guid.NewGuid().ToString("N") + ".json");
                                try {
                                    if (s.GetFile(objId, "/.retrotunes_device.json", tmp) && File.Exists(tmp)) {
                                        manifestJson = File.ReadAllText(tmp, Encoding.UTF8);
                                        hasManifest = true;
                                    }
                                } finally {
                                    try { if (File.Exists(tmp)) File.Delete(tmp); } catch { }
                                }
                            }

                            storagesJson.Add(
                                "{" +
                                "\"storageId\":" + JsonEscape(objId) + "," +
                                "\"description\":" + JsonEscape(desc) + "," +
                                "\"maxCapacity\":" + maxCap + "," +
                                "\"freeSpaceInBytes\":" + freeSpace + "," +
                                "\"hasManifest\":" + (hasManifest ? "true" : "false") + "," +
                                "\"manifestJson\":" + (manifestJson != null ? JsonEscape(manifestJson) : "null") +
                                "}"
                            );
                        }

                        string friendly = !string.IsNullOrEmpty(deviceName) ? deviceName : (!string.IsNullOrEmpty(s.FriendlyName) ? s.FriendlyName : "MTP Device");
                        Console.WriteLine(
                            "{" +
                            "\"connected\":true," +
                            "\"friendlyName\":" + JsonEscape(friendly) + "," +
                            "\"manufacturer\":" + JsonEscape(s.Manufacturer) + "," +
                            "\"product\":" + JsonEscape(friendly) + "," +
                            "\"serial\":" + JsonEscape(s.Serial) + "," +
                            "\"storages\":[" + string.Join(",", storagesJson) + "]" +
                            "}"
                        );
                        return 0;
                    }

                    if (cmd == "ls" && args.Length >= 3) {
                        string dirId = s.ResolvePath(args[1], args[2]);
                        if (dirId == null) {
                            Console.WriteLine("[]");
                            return 0;
                        }
                        var items = new List<string>();
                        foreach (var cid in s.EnumChildIds(dirId)) {
                            string name = s.GetName(cid);
                            bool isDir = s.IsDir(cid);
                            ulong size = isDir ? 0 : s.GetUlongProp(cid, WpdKeys.WPD_OBJECT_SIZE);
                            items.Add("{\"name\":" + JsonEscape(name) + ",\"isDir\":" + (isDir ? "true" : "false") + ",\"size\":" + size + "}");
                        }
                        Console.WriteLine("[" + string.Join(",", items) + "]");
                        return 0;
                    }

                    if (cmd == "mkdir" && args.Length >= 3) {
                        s.EnsureDir(args[1], args[2]);
                        return 0;
                    }

                    if (cmd == "get" && args.Length >= 4) {
                        return s.GetFile(args[1], args[2], args[3]) ? 0 : 1;
                    }

                    if (cmd == "put" && args.Length >= 4) {
                        return s.PutFile(args[1], args[2], args[3]) ? 0 : 1;
                    }

                    if (cmd == "batch-put" && args.Length >= 3) {
                        string storageId = args[1];
                        string batchFile = args[2];
                        var lines = File.ReadAllLines(batchFile, Encoding.UTF8);
                        int total = 0;
                        foreach (var l in lines) if (!string.IsNullOrWhiteSpace(l)) total++;
                        int idx = 0;
                        foreach (var l in lines) {
                            if (string.IsNullOrWhiteSpace(l)) continue;
                            var parts = l.Split('\t');
                            if (parts.Length < 2) continue;
                            idx++;
                            if (s.PutFile(storageId, parts[0], parts[1])) {
                                Console.WriteLine("BATCH_OK " + idx + "/" + total + " " + parts[1]);
                                Console.Out.Flush();
                            }
                        }
                        return 0;
                    }
                }
            } catch (Exception ex) {
                Console.Error.WriteLine(ex.Message);
                return 1;
            }
            return 1;
        }
    }
}

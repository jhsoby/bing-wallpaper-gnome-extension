/* jslint esversion: 6 */

const St = imports.gi.St;
const Main = imports.ui.main;
const MessageTray = imports.ui.messageTray;
const Soup = imports.gi.Soup;
const Lang = imports.lang;
const Mainloop = imports.mainloop;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Util = imports.misc.util;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;
const Clipboard = St.Clipboard.get_default();
const CLIPBOARD_TYPE = St.ClipboardType.CLIPBOARD;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const Utils = Me.imports.utils;

const Convenience = Me.imports.convenience;
const Gettext = imports.gettext.domain('CommonsWallpaper');
const _ = Gettext.gettext;

const DefaultImageListPage = "User:Jon_Harald_Søby/wallpapers.json";
const CommonsImageURLbase = "https://commons.wikimedia.org/w/api.php?format=json&action=query&prop=imageinfo&iiprop=url|extmetadata&iiextmetadatafilter=ImageDescription|Artist|LicenseUrl|LicenseShortName&titles=";
const CommonsURL = "https://commons.wikimedia.org";
const IndicatorName = "CommonsWallpaperIndicator";
const TIMEOUT_SECONDS_ON_HTTP_ERROR = 1 * 3600; // retry in one hour if there is a http error
const ICON = "commons";

let monitors;
let monitorW; // largest (in pixels) monitor width
let monitorH; // largest (in pixels) monitor height

let commonsWallpaperIndicator=null;
let init_called=false;

function log(msg) {
    if (commonsWallpaperIndicator==null || commonsWallpaperIndicator._settings.get_boolean('debug-logging'))
        print("CommonsWallpaper extension: " + msg); // disable to keep the noise down in journal
}

// Utility function
function dump(object) {
    let output = '';
    for (let property in object) {
        output += property + ': ' + object[property]+'; ';
    }
    log(output);
}

function notifyError(msg) {
    Main.notifyError("CommonsWallpaper extension error", msg);
}

function doSetBackground(uri, schema) {
    let gsettings = new Gio.Settings({schema: schema});
    let prev = gsettings.get_string('picture-uri');
    uri = 'file://'+ uri;
    gsettings.set_string('picture-uri', uri);
    gsettings.set_string('picture-options', 'zoom');
    Gio.Settings.sync();
    gsettings.apply();
    return (prev != uri); // return true if background uri has changed
}

function friendly_time_diff(time, short = true) {
    // short we want to keep ~4-5 characters
    let timezone = GLib.TimeZone.new_local();
    let now = GLib.DateTime.new_now(timezone).to_unix();
    let seconds = time.to_unix() - now;

    if (seconds <= 0) {
        return "now";
    }
    else if (seconds < 60) {
        return "< 1 "+(short?"m":_("minutes"));
    }
    else if (seconds < 3600) {
        return Math.round(seconds/60)+" "+(short?"m":_("minutes"));
    }
    else if (seconds > 86400) {
        return Math.round(seconds/86400)+" "+(short?"d":_("days"));
    }
    else {
        return Math.round(seconds/3600)+" "+(short?"h":_("hours"));
    }
}

let httpSession = new Soup.SessionAsync();
Soup.Session.prototype.add_feature.call(httpSession, new Soup.ProxyResolverDefault());

const CommonsWallpaperIndicator = new Lang.Class({
    Name: IndicatorName,
    Extends: PanelMenu.Button,

    _init: function() {
        this.parent(0.0, IndicatorName);

        let gicon = Gio.icon_new_for_string(Me.dir.get_child('icons').get_path() + "/" + ICON + ".svg");
        this.icon = new St.Icon({gicon: gicon, style_class: 'system-status-icon'});
        this.actor.add_child(this.icon);

        this.title = "";
        this.filename = "";
        this.creator = "";
        this.license = ""; // license on Commons
        this.licenselink = ""; // link to license
        this.version = "0.1";
        this._updatePending = false;
        this._timeout = null;
        this.imageURL= ""; // link to image itself
        this.imageinfolink = ""; // link to Commons photo info page
        this.refreshdue = 0;
        this.refreshduetext = "";

        this._settings = Utils.getSettings();
        this._settings.connect('changed::hide', Lang.bind(this, function() {
            this.actor.visible = !this._settings.get_boolean('hide');
        }));

        this.resolution = this._settings.get_string("resolution");
        if (this.resolution == "auto") {
            this.resolution = "1920x1080";
        }
        this.resW = this.resolution.split("x")[0];
        this.resH = this.resolution.split("x")[1];

        this.actor.visible = !this._settings.get_boolean('hide');
        this.TIMEOUTSECONDS = this._settings.get_int('auto-refresh') * 3600;

        this.refreshDueItem = new PopupMenu.PopupMenuItem(_("(No refresh scheduled)"));
        this.titleItem = new PopupMenu.PopupImageMenuItem(_("Awaiting refresh …"), 'camera-photo-symbolic');
        this.creatorItem = new PopupMenu.PopupImageMenuItem(_("Awaiting refresh …"), 'face-monkey-symbolic');
        this.licenseItem = new PopupMenu.PopupImageMenuItem(_("Awaiting refresh …"), 'application-certificate-symbolic');
        this.clipboardItem = new PopupMenu.PopupMenuItem(_("Copy image URL to clipboard"));
        this.refreshItem = new PopupMenu.PopupImageMenuItem(_("Refresh now"), 'view-refresh-symbolic');
        this.settingsItem = new PopupMenu.PopupImageMenuItem(_("Settings"), 'preferences-system-symbolic');
        this.menu.addMenuItem(this.refreshItem);
        this.menu.addMenuItem(this.refreshDueItem);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addMenuItem(this.titleItem);
        this.menu.addMenuItem(this.creatorItem);
        this.menu.addMenuItem(this.licenseItem);
        this.menu.addMenuItem(this.clipboardItem);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addMenuItem(this.settingsItem);
        this.creatorItem.setSensitive(false);
        this.licenseItem.connect('activate', Lang.bind(this, function() {
            if (this.licenselink)
              Util.spawn(["xdg-open", this.licenselink]);
        }));
        this.refreshDueItem.setSensitive(false);
        this.titleItem.connect('activate', Lang.bind(this, function() {
            if (this.imageinfolink)
              Util.spawn(["xdg-open", this.imageinfolink]);
        }));
        this.clipboardItem.connect('activate', Lang.bind(this, this._copyURLToClipboard));
        this.refreshItem.connect('activate', Lang.bind(this, this._refresh));
        this.settingsItem.connect('activate', function() {
            Util.spawn(["gnome-shell-extension-prefs", Me.metadata.uuid]);
        });

        this.actor.connect('button-press-event', Lang.bind(this, function () {
            // Grey out menu items if an update is pending
            this.refreshItem.setSensitive(!this._updatePending);
            this.clipboardItem.setSensitive(!this._updatePending && this.imageURL != "");
            this.titleItem.setSensitive(!this._updatePending && this.imageinfolink != "");
            this.licenseItem.setSensitive(!this._updatePending);
            this.refreshduetext = _("Next refresh: $1 ($2)").replace('$1', this.refreshdue.format("%X")).replace('$2', friendly_time_diff(this.refreshdue));
            this.refreshDueItem.label.set_text(this.refreshduetext); //
        }));
        this._restartTimeout(60); // wait 60 seconds before performing refresh
    },

    _setBackground: function() {
        if (this.filename == "")
            return;

        if (this._settings.get_boolean('set-background'))
            doSetBackground(this.filename, 'org.gnome.desktop.background');

        if (this._settings.get_boolean('set-lock-screen'))
            doSetBackground(this.filename, 'org.gnome.desktop.screensaver');
    },

    _copyURLToClipboard: function() {
        Clipboard.set_text(CLIPBOARD_TYPE, this.imageURL);
    },

    _restartTimeout: function(seconds = null) {
        if (this._timeout)
            Mainloop.source_remove(this._timeout);
        if (seconds == null)
            seconds = this.TIMEOUTSECONDS;
        this._timeout = Mainloop.timeout_add_seconds(seconds, Lang.bind(this, this._refresh));
        let timezone = GLib.TimeZone.new_local();
        let localTime = GLib.DateTime.new_now(timezone).add_seconds(seconds);
        this.refreshdue = localTime;
        log('next check in '+seconds+' seconds @ local time '+localTime);
    },

    _setMenuText: function() {
        this.titleItem.label.set_text(this.title);
        this.creatorItem.label.set_text(this.creator);
        this.licenseItem.label.set_text(this.license);
    },

    _refresh: function(heightmatters = false) {
        if (this._updatePending)
            return;
        this._updatePending = true;

        this._restartTimeout();

        let ImageListPage = this._settings.get_string('image-list-page');
        if (ImageListPage == '') {
            ImageListPage = DefaultImageListPage;
        }
        ImageListPage = ImageListPage.replace(' ', '_');
        this._settings.set_string('image-list-page', ImageListPage);
        let ImageListURL = 'https://commons.wikimedia.org/w/index.php?title=' +
            encodeURI(ImageListPage) + '&action=raw&ctype=application/json';
        log("Image list page detected as https://commons.wikimedia.org/wiki/" + ImageListPage);

        let APIrequest = Soup.Message.new('GET', ImageListURL);
        httpSession.queue_message(APIrequest, Lang.bind(this, function(httpSession, message) {
            if (message.status_code == 200) {
                let data = JSON.parse(message.response_body.data);
                let chosen1 = data[Math.floor(Math.random() * data.length)];
                let size = '&iiurlwidth=' + this.resW;
		if (heightmatters) {
                    size = '&iiurlheight=' + this.resH;
                }
		let request = Soup.Message.new('GET', CommonsImageURLbase + encodeURI(chosen1) + size);
                httpSession.queue_message(request, Lang.bind(this, function(httpSession, message2) {
                    if (message2.status_code == 200) {
                        let data2 = message2.response_body.data;
                        this._parseData(data2);
                    } else {
                        this._updatePending = false;
                        this._restartTimeout(TIMEOUT_SECONDS_ON_HTTP_ERROR);
                    }
                }));
            } else {
                this._updatePending = false;
                this._restartTimeout(TIMEOUT_SECONDS_ON_HTTP_ERROR);
            }
        }));
    },

    _parseData: function(data) {
        let parsed = JSON.parse(data)['query']['pages'];
        let imagejson = parsed[Object.keys(parsed)[0]];
        let imageinfo = imagejson['imageinfo']['0'];

        log('JSON returned (raw):\n' + data);

        function shortField(text) {
            text = text.replace(/<[^>]+>/g, '').replace(/\n/g, ' ');
            if (text.length > 70) {
                text = text.substring(0,68) + ' …';
            }
            return text;
        }

        if (imageinfo['thumburl']) {
            if (imageinfo['thumbheight'] < parseInt(this.resH)) {
                _refresh(heightmatters=true);
            }
            if ('ImageDescription' in imageinfo['extmetadata']) {
                this.title = shortField(imageinfo['extmetadata']['ImageDescription']['value']);
            } else {
                this.title = _('(No description …)');
            }
            if ('Artist' in imageinfo['extmetadata']) {
                this.creator = shortField(_('Creator: $1').replace('$1', imageinfo['extmetadata']['Artist']['value']));
            } else {
                this.creator = _('(No creator listed …)');
            }
            this.imageinfolink = imageinfo['descriptionurl'];
            this.license = shortField(_('License: $1').replace('$1', imageinfo['extmetadata']['LicenseShortName']['value']));
            if ('LicenseUrl' in imageinfo['extmetadata']) {
                this.licenselink = imageinfo['extmetadata']['LicenseUrl']['value'];
            } else {
                this.licenselink = 'javascript:void(0)';
            }

            this.imageURL = imageinfo['thumburl'];

            let CommonsWallpaperDir = this._settings.get_string('download-folder');
            let userPicturesDir = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_PICTURES);
            if (CommonsWallpaperDir == '') {
                CommonsWallpaperDir = userPicturesDir + "/CommonsWallpaper/";
		        this._settings.set_string('download-folder', CommonsWallpaperDir);
            }
            else if (!CommonsWallpaperDir.endsWith('/')) {
                CommonsWallpaperDir += '/';
            }

            log("XDG pictures directory detected as "+userPicturesDir+" saving pictures to "+CommonsWallpaperDir);
            // I would have liked to use the filename from Commons, but Ubuntu didn't like a lot of them, so we'll resort
            // to using the pageid as a filename instead, as it's simple, present in the API call we're using, and
            // guaranteed to be unique.
            this.filename = CommonsWallpaperDir + imagejson['pageid'] + '.jpg';
            //this.filename = CommonsWallpaperDir+this.imageURL.replace(/^.*[\\\/]/, '').replace(/\d{4}px-/, '');
            let file = Gio.file_new_for_path(this.filename);
            let file_exists = file.query_exists(null);
            let file_info = file_exists ? file.query_info ('*',Gio.FileQueryInfoFlags.NONE,null): 0;

            if (!file_exists || file_info.get_size () == 0) { // file doesn't exist or is empty (probably due to a network error)
                let dir = Gio.file_new_for_path(CommonsWallpaperDir);
                if (!dir.query_exists(null)) {
                    dir.make_directory_with_parents(null);
                }
                this._download_image(this.imageURL, file);
            } else {
                log("Image already downloaded");
                let changed = this._setBackground();
                this._updatePending = false;
            }
        } else {
            this.title = _("No wallpaper available");
            this.filename = "";
            this._updatePending = false;
        }
        this._setMenuText();
    },

    _download_image: function(url, file) {
        log("Downloading " + url + " to " + file.get_uri());

        // open the Gfile
        let fstream = file.replace(null, false, Gio.FileCreateFlags.NONE, null);

        // create an http message
        let request = Soup.Message.new('GET', url);

        // got_headers event
        request.connect('got_headers', Lang.bind(this, function(message){
            log("got_headers, status: "+message.status_code);
        }));

        // got_chunk event
        request.connect('got_chunk', Lang.bind(this, function(message, chunk){
	    //log("got_chuck, status: "+message.status_code);
	    if (message.status_code == 200) { // only save the data we want, not content of 301 redirect page
	    	fstream.write(chunk.get_data(), null);
	    }
	    else {
		log("got_chuck, status: "+message.status_code);
	    }
        }));

        // queue the http request
        httpSession.queue_message(request, Lang.bind(this, function(httpSession, message) {
            // request completed
            fstream.close(null);
            this._updatePending = false;
            if (message.status_code == 200) {
                log('Download successful');
                this._setBackground();
                this._add_to_previous_queue(this.filename);
            } else {
                log("Couldn't fetch image from " + url);
                file.delete(null);
            }
        }));
    },

    _add_to_previous_queue: function (filename) {
        let rawimagelist = this._settings.get_string('previous');
        let imagelist = rawimagelist.split(',');
        let maxpictures = this._settings.get_int('previous-days');
        let deletepictures = this._settings.get_boolean('delete-previous');

        log("Raw: "+ rawimagelist+" count: "+imagelist.length);
        log("Settings: delete:"+(deletepictures?"yes":"no")+" max: "+maxpictures);

        imagelist.push(filename); // add current to end of list

        while(imagelist.length > maxpictures+1) {
            var to_delete = imagelist.shift(); // get the first (oldest item from the list)
            log("image: "+to_delete);
            if (deletepictures && to_delete != '') {
                var file = Gio.file_new_for_path(to_delete);
                if (file.query_exists(null)) {
                    file.delete(null);
                    log("deleted file: "+ to_delete);
                }
            }
        }

        // put it back together and send back to settings
        rawimagelist = imagelist.join();
        this._settings.set_string('previous', rawimagelist);
        log("wrote back this: "+rawimagelist);
    },

    stop: function () {
        if (this._timeout)
            Mainloop.source_remove(this._timeout);
        this._timeout = undefined;
        this.menu.removeAll();
    }
});

function init(extensionMeta) {
    if (init_called === false) {
        Convenience.initTranslations("CommonsWallpaper");
        init_called = true;
        log("init() called");
    }
    else {
        log("WARNING: init() called more than once, ignoring");
   }
}

function enable() {
    log("enable() called");

    commonsWallpaperIndicator = new CommonsWallpaperIndicator();
    Main.panel.addToStatusArea(IndicatorName, commonsWallpaperIndicator);
    monitors = Main.layoutManager.monitors; // get list of connected monitors (and sizes)
    let largest = 0;
    for (let monitorIdx in monitors) {
        let monitor = monitors[monitorIdx];
        log("monitor "+monitorIdx+" -> "+monitor.width+" x "+monitor.height);
        if ((monitor.width * monitor.height) > largest) {
            monitorW = monitor.width;
            monitorH = monitor.height;
            largest = monitorW * monitorH;
        }
    }
}

function disable() {
    log("disable() called");
    if (this._timeout)
            Mainloop.source_remove(this._timeout);
    commonsWallpaperIndicator.stop();
    commonsWallpaperIndicator.destroy();
    commonsWallpaperIndicator = null;
}

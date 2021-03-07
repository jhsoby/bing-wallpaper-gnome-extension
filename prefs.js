
const Gtk = imports.gi.Gtk;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Me = imports.misc.extensionUtils.getCurrentExtension();
const Utils = Me.imports.utils;
const Soup = imports.gi.Soup;
const Lang = imports.lang;

let httpSession = new Soup.SessionAsync();
Soup.Session.prototype.add_feature.call(httpSession, new Soup.ProxyResolverDefault());

const Convenience = Me.imports.convenience;
const Gettext = imports.gettext.domain('CommonsWallpaper');
const _ = Gettext.gettext;

let settings;

let resolutions = [ 'auto', '1920x1200', '1920x1080', '1366x768', '1280x720', '1024x768', '800x600'];

function init() {
    settings = Utils.getSettings(Me);
    Convenience.initTranslations("CommonsWallpaper");
}

function buildPrefsWidget(){

    // Prepare labels and controls
    let buildable = new Gtk.Builder();
    buildable.add_from_file( Me.dir.get_path() + '/Settings.ui' );
    let box = buildable.get_object('prefs_widget');

    buildable.get_object('extension_version').set_text(" " + Me.metadata.version.toString());
    buildable.get_object('extension_name').set_text(Me.metadata.name.toString());

    let hideSwitch = buildable.get_object('hide');
    let bgSwitch = buildable.get_object('background');
    let lsSwitch = buildable.get_object('lock_screen');
    let fileChooser = buildable.get_object('download_folder');
    let imageList = buildable.get_object('image_list_page');
    let resolutionEntry = buildable.get_object('resolution');
    let deleteSwitch = buildable.get_object('delete_previous');
    let daysSpin = buildable.get_object('days_after_spinbutton');
    let hoursRefresh = buildable.get_object('hours_between_refresh');

    // previous wallpaper images
    let images=[];
    for(let i = 1; i <= 30; i++) {
        images.push(buildable.get_object('image'+i));
    }

    // check that these are valid (can be edited through dconf-editor)
    validate_resolution();

    // Indicator
    settings.bind('hide', hideSwitch, 'active', Gio.SettingsBindFlags.DEFAULT);

    settings.bind('set-background', bgSwitch, 'active', Gio.SettingsBindFlags.DEFAULT);
    settings.bind('set-lock-screen', lsSwitch, 'active', Gio.SettingsBindFlags.DEFAULT);

    //download folder
    fileChooser.set_filename(settings.get_string('download-folder'));
    log("fileChooser filename/dirname set to '"+fileChooser.get_filename()+"' setting is '"+settings.get_string('download-folder')+"'");
    fileChooser.add_shortcut_folder_uri("file://" + GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_PICTURES)+"/CommonsWallpaper");
    fileChooser.connect('file-set', function(widget) {
        settings.set_string('download-folder', widget.get_filename());
    });

    // image list page
    settings.bind('image-list-page', imageList, 'text', Gio.SettingsBindFlags.DEFAULT);

    resolutions.forEach(function (res) { // add res to dropdown list (aka a GtkComboText)
        resolutionEntry.append(res, res);
    })

    // Resolution
    settings.bind('resolution', resolutionEntry, 'active_id', Gio.SettingsBindFlags.DEFAULT);
    settings.connect('changed::resolution', function() {
        validate_resolution();
    });

    settings.bind('delete-previous', deleteSwitch, 'active', Gio.SettingsBindFlags.DEFAULT);
    settings.bind('previous-days', daysSpin, 'value', Gio.SettingsBindFlags.DEFAULT);
    settings.bind('auto-refresh', hoursRefresh, 'value', Gio.SettingsBindFlags.DEFAULT);

    box.show_all();

    return box;
};

function validate_resolution() {
    let resolution = settings.get_string('resolution');
    if (resolution == "" || resolutions.indexOf(resolution) == -1) // if not a valid resolution
        settings.reset('resolution');
}

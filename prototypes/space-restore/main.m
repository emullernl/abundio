// Prototype for ADR-0051: can a macOS 26 app put its own window back on the
// Space (desktop) it was on, after a user quit and relaunch?
//
// Chrome's method: save the window's AppKit restorable state ourselves, then
// replay it onto a new window through a decoder that answers the private
// `_windowRestorationOptions`. Without that method AppKit puts the window on
// the current Space, on purpose.
//
// Usage (see README.md):
//   SpaceRestore.app/Contents/MacOS/SpaceRestore save
//   SpaceRestore.app/Contents/MacOS/SpaceRestore restore        # with the private method
//   SpaceRestore.app/Contents/MacOS/SpaceRestore restore-plain  # control run, without it
#import <Cocoa/Cocoa.h>

static NSString *StatePath(void) {
    return [NSHomeDirectory() stringByAppendingPathComponent:@".space-restore-prototype.state"];
}

static void Log(NSString *fmt, ...) {
    va_list ap; va_start(ap, fmt);
    NSString *s = [[NSString alloc] initWithFormat:fmt arguments:ap];
    va_end(ap);
    fprintf(stderr, "[space-restore] %s\n", s.UTF8String);
    NSString *logPath = [NSHomeDirectory() stringByAppendingPathComponent:@".space-restore-prototype.log"];
    NSFileHandle *h = [NSFileHandle fileHandleForWritingAtPath:logPath];
    if (!h) { [@"" writeToFile:logPath atomically:NO encoding:NSUTF8StringEncoding error:nil]; h = [NSFileHandle fileHandleForWritingAtPath:logPath]; }
    [h seekToEndOfFile];
    [h writeData:[[NSString stringWithFormat:@"%@ %@\n", [NSDate date], s] dataUsingEncoding:NSUTF8StringEncoding]];
    [h closeFile];
}

// The decoder Chrome uses. Returning a default-initialised
// NSWindowRestorationOptions is what makes AppKit restore the Space.
@interface RestorationOptionsKeyedUnarchiver : NSKeyedUnarchiver
@property BOOL returnRestorationOptions;
@end
@implementation RestorationOptionsKeyedUnarchiver
- (id)_windowRestorationOptions {
    if (!self.returnRestorationOptions) return nil;
    Class c = NSClassFromString(@"NSWindowRestorationOptions");
    Log(@"_windowRestorationOptions asked; class %@", c ? @"found" : @"MISSING");
    return c ? [[c alloc] init] : nil;
}
@end

@interface Delegate : NSObject <NSApplicationDelegate, NSKeyedArchiverDelegate>
@property (strong) NSWindow *window;
@property (copy) NSString *mode;
@end

@implementation Delegate

- (NSWindow *)makeWindow:(NSString *)title {
    NSWindow *w = [[NSWindow alloc] initWithContentRect:NSMakeRect(200, 200, 520, 220)
        styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskResizable
        backing:NSBackingStoreBuffered defer:NO];
    w.title = title;
    w.releasedWhenClosed = NO;
    w.restorable = YES;
    w.identifier = @"space-restore-prototype";
    return w;
}

// Keeps the archiver from trying to encode the window itself or its views.
- (id)archiver:(NSKeyedArchiver *)archiver willEncodeObject:(id)object {
    if (object == self.window) return nil;
    if ([object isKindOfClass:[NSView class]]) return nil;
    return object;
}

- (void)save:(id)sender {
    NSKeyedArchiver *enc = [[NSKeyedArchiver alloc] initRequiringSecureCoding:YES];
    enc.delegate = self;
    [self.window encodeRestorableStateWithCoder:enc];
    [enc finishEncoding];
    NSData *data = enc.encodedData;
    [data writeToFile:StatePath() atomically:YES];
    Log(@"saved %lu bytes; frame %@; onActiveSpace=%d",
        (unsigned long)data.length, NSStringFromRect(self.window.frame), self.window.isOnActiveSpace);
    [NSApp terminate:nil];
}

- (void)applicationDidFinishLaunching:(NSNotification *)n {
    if ([self.mode isEqualToString:@"save"]) {
        self.window = [self makeWindow:@"Space restore prototype: SAVE"];
        NSTextField *label = [NSTextField wrappingLabelWithString:
            @"1. Move this window to another desktop (drag it to a desktop in Mission Control).\n"
             "2. Go to that desktop and click Save. The app quits."];
        label.frame = NSMakeRect(20, 80, 480, 110);
        [self.window.contentView addSubview:label];
        NSButton *b = [NSButton buttonWithTitle:@"Save" target:self action:@selector(save:)];
        b.frame = NSMakeRect(20, 20, 120, 32);
        [self.window.contentView addSubview:b];
        [self.window makeKeyAndOrderFront:nil];
        [NSApp activateIgnoringOtherApps:YES];
        return;
    }

    NSData *data = [NSData dataWithContentsOfFile:StatePath()];
    if (!data) { Log(@"no saved state; run 'save' first"); [NSApp terminate:nil]; return; }
    BOOL usePrivate = [self.mode isEqualToString:@"restore"];
    self.window = [self makeWindow:usePrivate ? @"RESTORED (private method)" : @"RESTORED (control, no private method)"];

    NSError *err = nil;
    RestorationOptionsKeyedUnarchiver *dec =
        [[RestorationOptionsKeyedUnarchiver alloc] initForReadingFromData:data error:&err];
    if (!dec) { Log(@"decoder failed: %@", err); [NSApp terminate:nil]; return; }
    // initForReadingFromData:error: already requires secure coding, which
    // AppKit's restoration asserts on (it crashed with this set to NO).
    dec.returnRestorationOptions = usePrivate;
    [self.window restoreStateWithCoder:dec];
    [dec finishDecoding];

    // Show without activating, as Chrome does during session restore:
    // activating a window on another Space would switch the user there.
    [self.window orderWindow:NSWindowBelow relativeTo:0];

    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(1.5 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        Log(@"mode=%@ frame=%@ visible=%d onActiveSpace=%d  (onActiveSpace=0 means it went to ANOTHER desktop)",
            self.mode, NSStringFromRect(self.window.frame), self.window.isVisible, self.window.isOnActiveSpace);
    });
}

// tao answers YES too, so this matches Abundio.
- (BOOL)applicationSupportsSecureRestorableState:(NSApplication *)a { return YES; }

- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)a { return YES; }
@end

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        NSString *mode = argc > 1 ? @(argv[1]) : @"save";
        if (![@[@"save", @"restore", @"restore-plain"] containsObject:mode]) {
            fprintf(stderr, "usage: SpaceRestore save | restore | restore-plain\n");
            return 2;
        }
        Log(@"--- launch, mode=%@, macOS %@", mode, [NSProcessInfo processInfo].operatingSystemVersionString);
        NSApplication *app = [NSApplication sharedApplication];
        [app setActivationPolicy:NSApplicationActivationPolicyRegular];
        Delegate *d = [Delegate new];
        d.mode = mode;
        app.delegate = d;
        [app run];
    }
    return 0;
}

#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <CoreGraphics/CoreGraphics.h>
#import <unistd.h>

static char *agentos_json_string(id object) {
    NSError *error = nil;
    NSData *data = [NSJSONSerialization dataWithJSONObject:object options:0 error:&error];
    if (!data || error) {
        NSString *fallback = [NSString stringWithFormat:@"{\"error\":\"%@\"}", error.localizedDescription ?: @"serialization_failed"];
        return strdup(fallback.UTF8String);
    }

    NSString *json = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    return strdup((json ?: @"{}").UTF8String);
}

static CGEventFlags agentos_modifier_flags(NSString *modifiersCSV) {
    if (!modifiersCSV.length) {
        return 0;
    }

    CGEventFlags flags = 0;
    for (NSString *raw in [modifiersCSV componentsSeparatedByString:@","]) {
        NSString *item = raw.lowercaseString;
        if ([item isEqualToString:@"shift"]) {
            flags |= kCGEventFlagMaskShift;
        } else if ([item isEqualToString:@"command"] || [item isEqualToString:@"cmd"]) {
            flags |= kCGEventFlagMaskCommand;
        } else if ([item isEqualToString:@"control"] || [item isEqualToString:@"ctrl"]) {
            flags |= kCGEventFlagMaskControl;
        } else if ([item isEqualToString:@"option"] || [item isEqualToString:@"alt"]) {
            flags |= kCGEventFlagMaskAlternate;
        } else if ([item isEqualToString:@"fn"] || [item isEqualToString:@"function"]) {
            flags |= kCGEventFlagMaskSecondaryFn;
        }
    }

    return flags;
}

static BOOL agentos_lookup_key_code(NSString *key, CGKeyCode *code) {
    NSDictionary<NSString *, NSNumber *> *codes = @{
        @"a": @0,
        @"s": @1,
        @"d": @2,
        @"f": @3,
        @"h": @4,
        @"g": @5,
        @"z": @6,
        @"x": @7,
        @"c": @8,
        @"v": @9,
        @"b": @11,
        @"q": @12,
        @"w": @13,
        @"e": @14,
        @"r": @15,
        @"y": @16,
        @"t": @17,
        @"1": @18,
        @"2": @19,
        @"3": @20,
        @"4": @21,
        @"6": @22,
        @"5": @23,
        @"=": @24,
        @"9": @25,
        @"7": @26,
        @"-": @27,
        @"8": @28,
        @"0": @29,
        @"]": @30,
        @"o": @31,
        @"u": @32,
        @"[": @33,
        @"i": @34,
        @"p": @35,
        @"l": @37,
        @"j": @38,
        @"'": @39,
        @"k": @40,
        @";": @41,
        @"\\": @42,
        @",": @43,
        @"/": @44,
        @"n": @45,
        @"m": @46,
        @".": @47,
        @"return": @36,
        @"enter": @36,
        @"tab": @48,
        @"space": @49,
        @"escape": @53,
        @"esc": @53,
        @"delete": @51,
        @"backspace": @51,
        @"f1": @122,
        @"f2": @120,
        @"f3": @99,
        @"f4": @118,
        @"f5": @96,
        @"f6": @97,
        @"f7": @98,
        @"f8": @100,
        @"f9": @101,
        @"f10": @109,
        @"f11": @103,
        @"f12": @111,
        @"left": @123,
        @"right": @124,
        @"down": @125,
        @"up": @126
    };

    NSNumber *value = codes[key.lowercaseString];
    if (!value) {
        return NO;
    }

    *code = (CGKeyCode)value.unsignedShortValue;
    return YES;
}

static void agentos_post_mouse_event(CGEventType type, CGPoint point, CGMouseButton button) {
    CGEventSourceRef source = CGEventSourceCreate(kCGEventSourceStateHIDSystemState);
    CGEventRef event = CGEventCreateMouseEvent(source, type, point, button);
    if (event) {
        CGEventPost(kCGHIDEventTap, event);
        CFRelease(event);
    }
    if (source) {
        CFRelease(source);
    }
}

char *agentos_macos_permissions_status_json(void) {
    @autoreleasepool {
        return agentos_json_string(@{
            @"accessibility": @(AXIsProcessTrusted()),
            @"screenRecording": @(CGPreflightScreenCaptureAccess())
        });
    }
}

char *agentos_macos_list_windows_json(void) {
    @autoreleasepool {
        CFArrayRef rawEntries = CGWindowListCopyWindowInfo(
            kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
            kCGNullWindowID
        );
        NSArray *entries = CFBridgingRelease(rawEntries);
        NSMutableArray *windows = [NSMutableArray array];

        for (NSDictionary *entry in entries ?: @[]) {
            NSString *ownerName = entry[(NSString *)kCGWindowOwnerName] ?: @"";
            NSString *windowName = entry[(NSString *)kCGWindowName] ?: @"";
            NSNumber *layer = entry[(NSString *)kCGWindowLayer] ?: @0;
            NSNumber *alpha = entry[(NSString *)kCGWindowAlpha] ?: @1;
            if (!ownerName.length || layer.intValue != 0 || alpha.doubleValue <= 0) {
                continue;
            }

            CGRect bounds = CGRectZero;
            NSDictionary *boundsDict = entry[(NSString *)kCGWindowBounds];
            if (boundsDict) {
                CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)boundsDict, &bounds);
            }

            [windows addObject:@{
                @"windowNumber": entry[(NSString *)kCGWindowNumber] ?: @0,
                @"ownerName": ownerName,
                @"windowName": windowName,
                @"ownerPID": entry[(NSString *)kCGWindowOwnerPID] ?: @0,
                @"layer": layer,
                @"alpha": alpha,
                @"bounds": @{
                    @"x": @(bounds.origin.x),
                    @"y": @(bounds.origin.y),
                    @"width": @(bounds.size.width),
                    @"height": @(bounds.size.height),
                    @"centerX": @(CGRectGetMidX(bounds)),
                    @"centerY": @(CGRectGetMidY(bounds))
                }
            }];
        }

        return agentos_json_string(@{ @"windows": windows });
    }
}

char *agentos_macos_type_text_json(const char *text) {
    @autoreleasepool {
        NSString *value = [NSString stringWithUTF8String:text ?: ""];
        NSUInteger length = value.length;
        UniChar *characters = length ? calloc(length, sizeof(UniChar)) : NULL;
        [value getCharacters:characters range:NSMakeRange(0, length)];

        CGEventSourceRef source = CGEventSourceCreate(kCGEventSourceStateHIDSystemState);
        CGEventRef down = CGEventCreateKeyboardEvent(source, 0, true);
        CGEventRef up = CGEventCreateKeyboardEvent(source, 0, false);
        if (characters && down && up) {
            CGEventKeyboardSetUnicodeString(down, length, characters);
            CGEventKeyboardSetUnicodeString(up, length, characters);
        }
        if (down) {
            CGEventPost(kCGHIDEventTap, down);
            CFRelease(down);
        }
        if (up) {
            CGEventPost(kCGHIDEventTap, up);
            CFRelease(up);
        }
        if (source) {
            CFRelease(source);
        }
        if (characters) {
            free(characters);
        }

        return agentos_json_string(@{
            @"typed": @(value.length),
            @"text": value
        });
    }
}

char *agentos_macos_key_press_json(const char *key, const char *modifiersCSV) {
    @autoreleasepool {
        NSString *value = [NSString stringWithUTF8String:key ?: ""];
        CGKeyCode code = 0;
        if (!agentos_lookup_key_code(value, &code)) {
            return agentos_json_string(@{
                @"pressed": @NO,
                @"error": [NSString stringWithFormat:@"Unsupported key: %@", value]
            });
        }

        CGEventSourceRef source = CGEventSourceCreate(kCGEventSourceStateHIDSystemState);
        CGEventFlags flags = agentos_modifier_flags([NSString stringWithUTF8String:modifiersCSV ?: ""]);
        CGEventRef down = CGEventCreateKeyboardEvent(source, code, true);
        CGEventRef up = CGEventCreateKeyboardEvent(source, code, false);
        if (down) {
            CGEventSetFlags(down, flags);
            CGEventPost(kCGHIDEventTap, down);
            CFRelease(down);
        }
        if (up) {
            CGEventSetFlags(up, flags);
            CGEventPost(kCGHIDEventTap, up);
            CFRelease(up);
        }
        if (source) {
            CFRelease(source);
        }

        return agentos_json_string(@{
            @"pressed": @YES,
            @"key": value
        });
    }
}

char *agentos_macos_click_at_json(double x, double y) {
    @autoreleasepool {
        CGPoint point = CGPointMake(x, y);
        agentos_post_mouse_event(kCGEventMouseMoved, point, kCGMouseButtonLeft);
        usleep(12000);
        agentos_post_mouse_event(kCGEventLeftMouseDown, point, kCGMouseButtonLeft);
        usleep(18000);
        agentos_post_mouse_event(kCGEventLeftMouseUp, point, kCGMouseButtonLeft);
        return agentos_json_string(@{
            @"ok": @YES,
            @"x": @(x),
            @"y": @(y)
        });
    }
}

char *agentos_macos_move_mouse_json(double x, double y) {
    @autoreleasepool {
        agentos_post_mouse_event(kCGEventMouseMoved, CGPointMake(x, y), kCGMouseButtonLeft);
        return agentos_json_string(@{
            @"ok": @YES,
            @"x": @(x),
            @"y": @(y)
        });
    }
}

char *agentos_macos_scroll_json(double dx, double dy) {
    @autoreleasepool {
        CGEventSourceRef source = CGEventSourceCreate(kCGEventSourceStateHIDSystemState);
        CGEventRef event = CGEventCreateScrollWheelEvent(source, kCGScrollEventUnitPixel, 2, (int32_t)dy, (int32_t)dx);
        if (event) {
            CGEventPost(kCGHIDEventTap, event);
            CFRelease(event);
        }
        if (source) {
            CFRelease(source);
        }
        return agentos_json_string(@{
            @"ok": @YES,
            @"dx": @(dx),
            @"dy": @(dy)
        });
    }
}

void agentos_macos_free_string(char *value) {
    if (value) {
        free(value);
    }
}

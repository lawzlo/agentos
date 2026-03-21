#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>
#import <Vision/Vision.h>
#import <ApplicationServices/ApplicationServices.h>
#import <CoreGraphics/CoreGraphics.h>
#import <ImageIO/ImageIO.h>

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

static NSDictionary *agentos_box_dictionary(CGRect box, CGFloat width, CGFloat height, CGFloat offsetX, CGFloat offsetY, CGFloat scale) {
    CGFloat effectiveScale = scale > 0 ? scale : 1;
    CGRect rect = CGRectMake(
        offsetX + ((box.origin.x * width) / effectiveScale),
        offsetY + (((1 - box.origin.y - box.size.height) * height) / effectiveScale),
        (box.size.width * width) / effectiveScale,
        (box.size.height * height) / effectiveScale
    );

    return @{
        @"x": @(rect.origin.x),
        @"y": @(rect.origin.y),
        @"width": @(rect.size.width),
        @"height": @(rect.size.height),
        @"centerX": @(CGRectGetMidX(rect)),
        @"centerY": @(CGRectGetMidY(rect))
    };
}

static NSArray *agentos_recognize_text(CGImageRef image, CGFloat offsetX, CGFloat offsetY, CGFloat scale) {
    if (!image) {
        return @[];
    }

    VNRecognizeTextRequest *request = [[VNRecognizeTextRequest alloc] init];
    request.recognitionLevel = VNRequestTextRecognitionLevelAccurate;
    request.usesLanguageCorrection = YES;

    NSError *error = nil;
    VNImageRequestHandler *handler = [[VNImageRequestHandler alloc] initWithCGImage:image options:@{}];
    [handler performRequests:@[request] error:&error];
    if (error) {
        return @[];
    }

    CGFloat width = (CGFloat)CGImageGetWidth(image);
    CGFloat height = (CGFloat)CGImageGetHeight(image);
    NSMutableArray *observations = [NSMutableArray array];
    for (VNRecognizedTextObservation *observation in request.results ?: @[]) {
        VNRecognizedText *candidate = [[observation topCandidates:1] firstObject];
        if (!candidate) {
            continue;
        }

        [observations addObject:@{
            @"text": candidate.string ?: @"",
            @"confidence": @(candidate.confidence),
            @"box": agentos_box_dictionary(observation.boundingBox, width, height, offsetX, offsetY, scale)
        }];
    }

    return observations;
}

static CGImageRef agentos_create_image_from_path(const char *path) {
    if (!path) {
        return nil;
    }

    NSURL *url = [NSURL fileURLWithPath:[NSString stringWithUTF8String:path]];
    CGImageSourceRef source = CGImageSourceCreateWithURL((__bridge CFURLRef)url, NULL);
    if (!source) {
        return nil;
    }

    CGImageRef image = CGImageSourceCreateImageAtIndex(source, 0, NULL);
    CFRelease(source);
    return image;
}

static CGImageRef agentos_crop_image(CGImageRef image, CGRect region) {
    if (!image) {
        return nil;
    }

    CGFloat width = (CGFloat)CGImageGetWidth(image);
    CGFloat height = (CGFloat)CGImageGetHeight(image);
    CGRect cropRect = CGRectMake(
        MAX(0, MIN(width - 1, region.origin.x * width)),
        MAX(0, MIN(height - 1, region.origin.y * height)),
        MAX(1, MIN(width, region.size.width * width)),
        MAX(1, MIN(height, region.size.height * height))
    );
    cropRect.origin.x = MIN(cropRect.origin.x, width - cropRect.size.width);
    cropRect.origin.y = MIN(cropRect.origin.y, height - cropRect.size.height);
    return CGImageCreateWithImageInRect(image, cropRect);
}

static CGImageRef agentos_scale_image(CGImageRef image, CGFloat scale) {
    if (!image || scale <= 1.01) {
        return image ? CGImageRetain(image) : nil;
    }

    size_t width = (size_t)MAX(1, CGImageGetWidth(image) * scale);
    size_t height = (size_t)MAX(1, CGImageGetHeight(image) * scale);
    CGColorSpaceRef colorSpace = CGColorSpaceCreateDeviceRGB();
    CGContextRef context = CGBitmapContextCreate(
        NULL,
        width,
        height,
        8,
        0,
        colorSpace,
        kCGImageAlphaPremultipliedLast | kCGBitmapByteOrder32Big
    );
    CGColorSpaceRelease(colorSpace);
    if (!context) {
        return CGImageRetain(image);
    }

    CGContextSetInterpolationQuality(context, kCGInterpolationHigh);
    CGContextDrawImage(context, CGRectMake(0, 0, width, height), image);
    CGImageRef scaled = CGBitmapContextCreateImage(context);
    CGContextRelease(context);
    return scaled ?: CGImageRetain(image);
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
        }
    }

    return flags;
}

static BOOL agentos_lookup_key_code(NSString *key, CGKeyCode *code) {
    NSDictionary<NSString *, NSNumber *> *codes = @{
        @"return": @36,
        @"enter": @36,
        @"tab": @48,
        @"space": @49,
        @"escape": @53,
        @"esc": @53,
        @"delete": @51,
        @"backspace": @51,
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

char *agentos_macos_ocr_image_json(const char *path) {
    @autoreleasepool {
        CGImageRef image = agentos_create_image_from_path(path);
        NSArray *observations = agentos_recognize_text(image, 0, 0, 1);
        if (image) {
            CGImageRelease(image);
        }
        return agentos_json_string(@{ @"observations": observations ?: @[] });
    }
}

char *agentos_macos_ocr_image_region_json(const char *path, double x, double y, double width, double height, double scale) {
    @autoreleasepool {
        CGImageRef image = agentos_create_image_from_path(path);
        if (!image) {
            return agentos_json_string(@{ @"observations": @[] });
        }

        CGRect normalizedRegion = CGRectMake(
            MAX(0, MIN(1, x)),
            MAX(0, MIN(1, y)),
            MAX(0.01, MIN(1, width)),
            MAX(0.01, MIN(1, height))
        );
        if (normalizedRegion.origin.x + normalizedRegion.size.width > 1) {
            normalizedRegion.size.width = MAX(0.01, 1 - normalizedRegion.origin.x);
        }
        if (normalizedRegion.origin.y + normalizedRegion.size.height > 1) {
            normalizedRegion.size.height = MAX(0.01, 1 - normalizedRegion.origin.y);
        }

        CGFloat imageWidth = (CGFloat)CGImageGetWidth(image);
        CGFloat imageHeight = (CGFloat)CGImageGetHeight(image);
        CGFloat offsetX = normalizedRegion.origin.x * imageWidth;
        CGFloat offsetY = normalizedRegion.origin.y * imageHeight;
        CGImageRef cropped = agentos_crop_image(image, normalizedRegion);
        CGImageRef scaled = agentos_scale_image(cropped, MAX(1, scale));
        NSArray *observations = agentos_recognize_text(scaled, offsetX, offsetY, MAX(1, scale));

        if (scaled) {
            CGImageRelease(scaled);
        }
        if (cropped) {
            CGImageRelease(cropped);
        }
        CGImageRelease(image);
        return agentos_json_string(@{ @"observations": observations ?: @[] });
    }
}

char *agentos_macos_find_text_json(const char *path, const char *query) {
    @autoreleasepool {
        CGImageRef image = agentos_create_image_from_path(path);
        NSArray *observations = agentos_recognize_text(image, 0, 0, 1);
        if (image) {
            CGImageRelease(image);
        }

        NSString *queryString = [[NSString stringWithUTF8String:query ?: ""] lowercaseString];
        NSArray *ranked = [observations sortedArrayUsingComparator:^NSComparisonResult(NSDictionary *left, NSDictionary *right) {
            NSString *leftText = [left[@"text"] lowercaseString] ?: @"";
            NSString *rightText = [right[@"text"] lowercaseString] ?: @"";
            NSInteger leftScore = [leftText isEqualToString:queryString] ? 2 : ([leftText containsString:queryString] ? 1 : 0);
            NSInteger rightScore = [rightText isEqualToString:queryString] ? 2 : ([rightText containsString:queryString] ? 1 : 0);
            if (leftScore != rightScore) {
                return leftScore > rightScore ? NSOrderedAscending : NSOrderedDescending;
            }
            float leftConfidence = [left[@"confidence"] floatValue];
            float rightConfidence = [right[@"confidence"] floatValue];
            if (leftConfidence == rightConfidence) {
                return NSOrderedSame;
            }
            return leftConfidence > rightConfidence ? NSOrderedAscending : NSOrderedDescending;
        }];

        for (NSDictionary *candidate in ranked) {
            NSString *text = [candidate[@"text"] lowercaseString] ?: @"";
            if ([text isEqualToString:queryString] || [text containsString:queryString]) {
                return agentos_json_string(@{
                    @"found": @YES,
                    @"match": candidate,
                    @"count": @(observations.count)
                });
            }
        }

        return agentos_json_string(@{
            @"found": @NO,
            @"count": @(observations.count)
        });
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
        agentos_post_mouse_event(kCGEventLeftMouseDown, point, kCGMouseButtonLeft);
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

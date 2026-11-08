#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Runs `block`, catching an Objective-C exception instead of letting it crash the app.
/// Returns the exception's reason if one was thrown, or nil if the block ran normally.
/// (Swift can't catch these itself; Apple's audio engine throws them when it refuses to start,
/// for example while the Mac is going to sleep or waking up.)
NSString * _Nullable CadenzaCatch(NS_NOESCAPE void (^block)(void));

NS_ASSUME_NONNULL_END

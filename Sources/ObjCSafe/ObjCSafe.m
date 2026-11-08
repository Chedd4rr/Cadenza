#import "ObjCSafe.h"

NSString *CadenzaCatch(NS_NOESCAPE void (^block)(void)) {
    @try {
        block();
        return nil;
    } @catch (NSException *e) {
        return e.reason ?: e.name;
    }
}

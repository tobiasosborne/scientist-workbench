// Probe L4: Boost cyl_neumann (Y_ν) cancellation tail at moderate-large z.
// Boost docs note: Y_ν loses precision through cancellation near zeros and at large z.
// Build:  g++ -std=c++17 -O2 boost-y-tail-test.cpp -o boost-y-tail-test
#include <iostream>
#include <iomanip>
#include <boost/multiprecision/cpp_bin_float.hpp>
#include <boost/math/special_functions/bessel.hpp>
int main() {
    using namespace boost::multiprecision;
    using Real50 = number<cpp_bin_float<50>>;
    std::cout << std::setprecision(50);

    // Y_0 at z = 1e6, 1e8, 1e10 — both float64 and cpp_bin_float<50>
    std::cout << "=== L4 Boost Y_0 at large z ===\n";
    std::cout << "Y_0(1e6) double  = " << std::setprecision(17) << boost::math::cyl_neumann(0.0, 1e6)  << "\n";
    std::cout << "Y_0(1e6) bf50    = " << std::setprecision(50) << boost::math::cyl_neumann(Real50(0), Real50("1e6")) << "\n";
    std::cout << "Y_0(1e8) double  = " << std::setprecision(17) << boost::math::cyl_neumann(0.0, 1e8)  << "\n";
    std::cout << "Y_0(1e8) bf50    = " << std::setprecision(50) << boost::math::cyl_neumann(Real50(0), Real50("1e8")) << "\n";
    std::cout << "Y_0(1e10) double = " << std::setprecision(17) << boost::math::cyl_neumann(0.0, 1e10) << "\n";
    std::cout << "Y_0(1e10) bf50   = " << std::setprecision(50) << boost::math::cyl_neumann(Real50(0), Real50("1e10")) << "\n";

    // Around a Y_0 zero (z₁ ≈ 0.8935769662791675)
    Real50 y0_zero("0.89357696627916752158488710205833824121118103979213");
    std::cout << "\nY_0 at 1st zero (~0.8935) bf50 = " << std::setprecision(50) << boost::math::cyl_neumann(Real50(0), y0_zero) << "\n";

    return 0;
}

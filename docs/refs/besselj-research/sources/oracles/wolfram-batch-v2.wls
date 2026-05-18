(* Wolfram batch — embed all inputs as a list, evaluate once, emit per-line JSON.
   This is the proven pattern from Erf G2. *)
inputs = {
  {"BesselJ", "3",    "2",     50},
  {"BesselY", "5/2",  "3/2",   50},
  {"BesselI", "1/2",  "3",     50},
  {"BesselK", "0",    "10",    50},
  {"BesselJ", "3",    "25/10", 50}
};
Do[
  {fnN, nuS, zS, prec} = inputs[[k]];
  fnSym = Switch[fnN, "BesselJ", BesselJ, "BesselY", BesselY, "BesselI", BesselI, "BesselK", BesselK];
  nu = ToExpression[nuS];
  z  = ToExpression[zS];
  result = N[fnSym[nu, z], prec];
  raw = ToString[result, InputForm];
  (* Strip back-tick precision suffix; normalise *^ exponent to e *)
  clean = StringReplace[StringSplit[raw, "`"][[1]], "*^" -> "e"];
  Print["{\"idx\":", k, ",\"fn\":\"", fnN, "\",\"nu\":\"", nuS, "\",\"z\":\"", zS, "\",\"prec\":", prec, ",\"result\":\"", clean, "\"}"];
, {k, Length[inputs]}];
